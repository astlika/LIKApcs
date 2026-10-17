import type { FastifyPluginAsync } from 'fastify';
import type { WebSocket } from 'ws';
import {
  PERMISSIONS,
  PROTOCOL_VERSION,
  WS_CLOSE_CODES,
  adminMessageSchema,
  type ServerError,
  type ServerPong,
  type ServerWelcomeToAdmin,
} from '@likapcs/shared';
import type { AdminPresence } from './hub.js';
import { recordAudit } from '../services/audit.js';
import { SERVER_VERSION } from '../version.js';

const HELLO_TIMEOUT_MS = 10_000;

function send(socket: WebSocket, message: unknown): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
}

function fail(socket: WebSocket, code: number, errorCode: string, message: string): void {
  const body: ServerError = { type: 'server.error', code: errorCode, message };
  send(socket, body);
  socket.close(code, message.slice(0, 120));
}

/** /ws/admin — live event stream for LIKApcs Admin (station changes, device registrations…). */
export const adminSocketRoutes: FastifyPluginAsync = async (app) => {
  const { hub, services, pool } = app;

  app.get('/ws/admin', { websocket: true }, (socket, request) => {
    let presence: AdminPresence | null = null;
    const helloTimer = setTimeout(() => {
      if (!presence)
        fail(socket, WS_CLOSE_CODES.PROTOCOL_ERROR, 'hello_timeout', 'hello not received in time');
    }, HELLO_TIMEOUT_MS);

    socket.on('message', (raw) => {
      void (async () => {
        let message;
        try {
          message = adminMessageSchema.parse(JSON.parse(raw.toString()));
        } catch {
          fail(socket, WS_CLOSE_CODES.PROTOCOL_ERROR, 'invalid_message', 'malformed message');
          return;
        }
        if (!presence) {
          if (message.type !== 'admin.hello') {
            fail(
              socket,
              WS_CLOSE_CODES.PROTOCOL_ERROR,
              'hello_expected',
              'first message must be admin.hello',
            );
            return;
          }
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
          const ctx = await services.auth.resolveToken(message.token);
          if (!ctx) {
            fail(socket, WS_CLOSE_CODES.UNAUTHORIZED, 'unauthorized', 'invalid session token');
            return;
          }
          presence = {
            socket,
            userId: ctx.user.id,
            username: ctx.user.username,
            connectedAt: new Date(),
            permissions: ctx.permissions,
          };
          hub.attachAdmin(presence);
          const welcome: ServerWelcomeToAdmin = {
            type: 'server.welcome',
            protocolVersion: PROTOCOL_VERSION,
            serverVersion: SERVER_VERSION,
            serverTime: new Date().toISOString(),
          };
          send(socket, welcome);
          return;
        }
        if (message.type === 'admin.ping') {
          const pong: ServerPong = { type: 'server.pong', serverTime: new Date().toISOString() };
          send(socket, pong);
          return;
        }
        if (message.type === 'admin.stream_start' || message.type === 'admin.stream_stop') {
          const { stationId } = message;
          if (!presence.permissions.has(PERMISSIONS.REMOTE_VIEW)) {
            send(socket, { type: 'server.stream_status', stationId, state: 'denied' });
            return;
          }
          const actor = { userId: presence.userId, label: presence.username };
          // One audit row per viewing session of a station (not per thumbnail refresh or per
          // switch between grid and focus).
          if (message.type === 'admin.stream_start') {
            const isNew = !hub.remote.isViewing(stationId, presence);
            const online = hub.remote.start(stationId, presence, message.mode);
            if (isNew) {
              await recordAudit(pool, actor, {
                action: 'remote.view_started',
                entityType: 'station',
                entityId: stationId,
                details: { online, mode: message.mode },
              });
            }
          } else {
            const wasViewing = hub.remote.isViewing(stationId, presence);
            hub.remote.stop(stationId, presence);
            if (wasViewing) {
              await recordAudit(pool, actor, {
                action: 'remote.view_ended',
                entityType: 'station',
                entityId: stationId,
                details: { reason: 'closed' },
              });
            }
          }
        }
      })().catch((err: unknown) => {
        request.log.error({ err }, 'admin socket handler failed');
        fail(socket, WS_CLOSE_CODES.PROTOCOL_ERROR, 'internal_error', 'internal error');
      });
    });

    socket.on('close', () => {
      clearTimeout(helloTimer);
      if (presence) {
        const actor = { userId: presence.userId, label: presence.username };
        for (const stationId of hub.remote.detachAdmin(presence)) {
          recordAudit(pool, actor, {
            action: 'remote.view_ended',
            entityType: 'station',
            entityId: stationId,
            details: { reason: 'connection_closed' },
          }).catch((err: unknown) => request.log.warn({ err }, 'remote view audit failed'));
        }
        hub.detachAdmin(presence);
      }
    });
    socket.on('error', (err) => request.log.warn({ err }, 'admin socket error'));
  });
};
