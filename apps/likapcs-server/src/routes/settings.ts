import type { FastifyPluginAsync } from 'fastify';
import { PERMISSIONS } from '@likapcs/shared';

export const settingsRoutes: FastifyPluginAsync = async (app) => {
  const { services } = app;

  app.get('/settings/public', async () => services.settings.getPublic());

  app.get('/settings', { preHandler: app.requirePermission(PERMISSIONS.SETTINGS_VIEW) }, async () =>
    services.settings.getAll(),
  );

  app.patch(
    '/settings',
    { preHandler: app.requirePermission(PERMISSIONS.SETTINGS_MANAGE) },
    async (request) => {
      const ctx = request.auth!;
      return services.settings.update(request.body, {
        userId: ctx.user.id,
        label: ctx.user.username,
        ip: request.ip,
      });
    },
  );
};
