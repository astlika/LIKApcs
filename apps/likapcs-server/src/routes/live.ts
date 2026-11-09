import type { FastifyPluginAsync } from 'fastify';
import { PERMISSIONS } from '@likapcs/shared';

/** Live tracking (0.31.0): today's figures, the staff and the feed. Read-only. */
export const liveRoutes: FastifyPluginAsync = async (app) => {
  const { services } = app;
  const view = { preHandler: app.requirePermission(PERMISSIONS.LIVE_VIEW) };

  app.get('/live/snapshot', view, async () => services.live.snapshot());
};
