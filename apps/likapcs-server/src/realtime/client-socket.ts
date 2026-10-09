import type { FastifyPluginAsync } from 'fastify';
import type { WebSocket } from 'ws';
import {
  PROTOCOL_VERSION,
  WS_CLOSE_CODES,
  clientMessageSchema,
  isCompatibleWithServer,
  type ServerError,
  type ServerHeartbeatAck,
  type ServerWelcomeToClient,
} from '@likapcs/shared';
import type { DevicePresence } from './hub.js';
import { shouldPushUpdate } from '../services/commands.js';
import { SERVER_VERSION } from '../version.js';

/** Delay before an outdated client is told to update, so the welcome/heartbeat settle first. */
const UPDATE_PUSH_DELAY_MS = 5_000;

const HELLO_TIMEOUT_MS = 10_000;

function send(socket: WebSocket, message: unknown): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
}

function fail(socket: WebSocket, code: number, errorCode: string, message: string): void {
  const body: ServerError = { type: 'server.error', code: errorCode, message };
  send(socket, body);
  socket.close(code, message.slice(0, 120));
}

/**
 * /ws/client — connection endpoint for LIKApcs-Client devices.
 *
 * Handshake: first frame must be `client.hello` with a valid device token whose machineId matches
 * the registered one. Then the server sends `server.welcome` (authoritative time, station identity,
 * current session state) and the client starts heartbeating.
 */
export const clientSocketRoutes: FastifyPluginAsync = async (app) => {
  const { hub, services } = app;

  app.get('/ws/client', { websocket: true }, (socket, request) => {
    const ip = request.ip ?? null;
    let presence: DevicePresence | null = null;
    let authenticating = false;

    const helloTimer = setTimeout(() => {
      if (!presence)
        fail(socket, WS_CLOSE_CODES.PROTOCOL_ERROR, 'hello_timeout', 'hello not received in time');
    }, HELLO_TIMEOUT_MS);

    socket.on('message', (raw) => {
      void (async () => {
        let message;
        try {
          message = clientMessageSchema.parse(JSON.parse(raw.toString()));
        } catch {
          fail(socket, WS_CLOSE_CODES.PROTOCOL_ERROR, 'invalid_message', 'malformed message');
          return;
        }

        if (!presence) {
          if (message.type !== 'client.hello' || authenticating) {
            fail(
              socket,
              WS_CLOSE_CODES.PROTOCOL_ERROR,
              'hello_expected',
              'first message must be client.hello',
            );
            return;
          }
          authenticating = true;
          clearTimeout(helloTimer);
          if (message.protocolVersion !== PROTOCOL_VERSION) {
            fail(
              socket,
              WS_CLOSE_CODES.INCOMPATIBLE_VERSION,
              'incompatible_protocol',
              `protocol ${PROTOCOL_VERSION} required`,
            );
            return;
          }
          if (!isCompatibleWithServer(message.appVersion, SERVER_VERSION)) {
            fail(
              socket,
              WS_CLOSE_CODES.INCOMPATIBLE_VERSION,
              'incompatible_version',
              `client ${message.appVersion} is not compatible with server ${SERVER_VERSION}`,
            );
            return;
          }
          const device = await services.devices.authenticate(message.token);
          if (!device || device.machineId !== message.machineId) {
            if (device)
              await services.devices.logConnection(device.id, device.station.id, 'rejected', {
                reason: 'machine id mismatch',
                ip,
              });
            fail(socket, WS_CLOSE_CODES.UNAUTHORIZED, 'unauthorized', 'device token rejected');
            return;
          }

          const now = new Date();
          presence = {
            deviceId: device.id,
            stationId: device.station.id,
            machineId: device.machineId,
            appVersion: message.appVersion,
            ip,
            socket,
            connectedAt: now,
            lastHeartbeatAt: now,
            lastMetrics: null,
            locked: null,
            seq: 0,
            pending: new Map(),
          };
          hub.attachDevice(presence);
          await services.devices.logConnection(device.id, device.station.id, 'connected', {
            ip,
            appVersion: message.appVersion,
          });
          await services.devices.recordHeartbeat(device.id, device.station.id, {
            appVersion: message.appVersion,
            ip,
            locked: null,
            metrics: null,
            sessionId: null,
          });

          const settings = await services.settings.getAll();
          const welcome: ServerWelcomeToClient = {
            type: 'server.welcome',
            protocolVersion: PROTOCOL_VERSION,
            serverVersion: SERVER_VERSION,
            serverTime: new Date().toISOString(),
            station: {
              id: device.station.id,
              number: device.station.number,
              code: device.station.code,
              name: device.station.name,
            },
            heartbeatIntervalSeconds: settings['stations.heartbeat_interval_seconds'],
            offlineAfterSeconds: settings['stations.offline_after_seconds'],
            language: settings['locale.default_language'],
            welcomeMessage: settings['stations.client_welcome_message'],
            businessName: settings['business.name'],
            session: null, // populated by the session service from Phase 3
          };
          send(socket, welcome);
          request.log.info(
            { deviceId: device.id, station: device.station.code, ip },
            'client connected',
          );

          // Owner policy: outdated clients update themselves (signed installer from GitHub Releases).
          if (
            shouldPushUpdate({
              clientVersion: message.appVersion,
              policy: settings['updates.client_policy'],
              maintenanceWindow: settings['updates.maintenance_window'],
              hasActiveSession: welcome.session !== null,
            })
          ) {
            const deviceId = device.id;
            setTimeout(() => {
              if (!hub.isDeviceOnline(deviceId)) return;
              void hub
                .sendCommand(deviceId, 'update.apply', {})
                .then((r) =>
                  request.log.info(
                    { deviceId, ok: r.ok, error: r.error },
                    'automatic client update requested',
                  ),
                );
            }, UPDATE_PUSH_DELAY_MS).unref();
          }
          return;
        }

        switch (message.type) {
          case 'client.heartbeat': {
            hub.touchDevice(presence.deviceId, message.metrics ?? null, message.locked ?? null);
            await services.devices.recordHeartbeat(presence.deviceId, presence.stationId, {
              appVersion: presence.appVersion,
              ip,
              locked: message.locked ?? null,
              metrics: message.metrics ?? null,
              sessionId: message.sessionId ?? null,
            });
            const ack: ServerHeartbeatAck = {
              type: 'server.heartbeat_ack',
              serverTime: new Date().toISOString(),
            };
            send(socket, ack);
            break;
          }
          case 'client.ack': {
            const known = hub.resolveAck(presence.deviceId, message.commandId, {
              ok: message.ok,
              error: message.error,
            });
            if (!known)
              request.log.warn(
                { deviceId: presence.deviceId, commandId: message.commandId },
                'ack for unknown or duplicate command ignored',
              );
            break;
          }
          case 'client.event': {
            if (message.event === 'error') {
              await services.devices.logConnection(
                presence.deviceId,
                presence.stationId,
                'error',
                message.payload,
              );
            }
            request.log.info({ deviceId: presence.deviceId, event: message.event }, 'client event');
            break;
          }
          case 'client.hello':
            fail(socket, WS_CLOSE_CODES.PROTOCOL_ERROR, 'already_authenticated', 'duplicate hello');
            break;
        }
      })().catch((err: unknown) => {
        request.log.error({ err }, 'client socket handler failed');
        fail(socket, WS_CLOSE_CODES.PROTOCOL_ERROR, 'internal_error', 'internal error');
      });
    });

    socket.on('close', (code, reason) => {
      clearTimeout(helloTimer);
      if (!presence) return;
      const current = presence;
      hub.detachDevice(current.deviceId, socket, `closed (${code})`);
      void services.devices
        .logConnection(
          current.deviceId,
          current.stationId,
          code === WS_CLOSE_CODES.REPLACED_BY_NEW_CONNECTION ? 'replaced' : 'disconnected',
          {
            code,
            reason: reason.toString(),
          },
        )
        .catch((err: unknown) => request.log.error({ err }, 'failed to log disconnect'));
    });

    socket.on('error', (err) => {
      request.log.warn({ err, deviceId: presence?.deviceId }, 'client socket error');
    });
  });
};
