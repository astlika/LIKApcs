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
import type { DbPool } from '../db/pool.js';
import type { ReleasedView } from './remote.js';
import { recordAudit } from '../services/audit.js';
import { SERVER_VERSION } from '../version.js';

const HELLO_TIMEOUT_MS = 10_000;

function send(socket: WebSocket, message: unknown): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
}

function sendError(socket: WebSocket, code: string, message: string): void {
  send(socket, { type: 'server.error', code, message } satisfies ServerError);
}

/** Records the end of each released view, and of each control that was on. */
async function recordReleased(
  pool: DbPool,
  released: ReleasedView[],
  reason: string,
): Promise<void> {
  for (const view of released) {
    const actor = { userId: view.admin.userId, label: view.admin.username };
    if (view.wasControlling) {
      await recordAudit(pool, actor, {
        action: 'remote.control_ended',
        entityType: 'station',
        entityId: view.stationId,
        details: { reason },
      });
    }
    await recordAudit(pool, actor, {
      action: 'remote.view_ended',
      entityType: 'station',
      entityId: view.stationId,
      details: { reason },
    });
  }
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
            const online = hub.remote.start(stationId, presence, message.mode, message.resolution);
            if (isNew) {
              await recordAudit(pool, actor, {
                action: 'remote.view_started',
                entityType: 'station',
                entityId: stationId,
                details: { online, mode: message.mode },
              });
            }
          } else {
            const released = hub.remote.stop(stationId, presence);
            if (released) await recordReleased(pool, [released], 'closed');
          }
          return;
        }
        if (message.type === 'admin.control') {
          const { stationId, on } = message;
          if (!presence.permissions.has(PERMISSIONS.REMOTE_CONTROL)) {
            sendError(socket, 'forbidden', 'no permission to control station PCs');
            return;
          }
          const change = hub.remote.setControl(stationId, presence, on);
          if (change === 'refused') {
            sendError(socket, 'not_focused', 'open the PC in focus view before controlling it');
            return;
          }
          if (change === 'started' || change === 'ended') {
            await recordAudit(
              pool,
              { userId: presence.userId, label: presence.username },
              {
                action: change === 'started' ? 'remote.control_started' : 'remote.control_ended',
                entityType: 'station',
                entityId: message.stationId,
                details: {},
              },
            );
          }
          return;
        }
        if (message.type === 'admin.input') {
          if (!presence.permissions.has(PERMISSIONS.REMOTE_CONTROL)) {
            sendError(socket, 'forbidden', 'no permission to control station PCs');
            return;
          }
          if (!hub.remote.relayInput(message.stationId, presence, message.event)) {
            sendError(socket, 'not_controlling', 'this PC is not under your control right now');
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
        void recordReleased(pool, hub.remote.detachAdmin(presence), 'connection_closed').catch(
          (err: unknown) => request.log.warn({ err }, 'remote view audit failed'),
        );
        hub.detachAdmin(presence);
      }
    });
    socket.on('error', (err) => request.log.warn({ err }, 'admin socket error'));
  });
};
