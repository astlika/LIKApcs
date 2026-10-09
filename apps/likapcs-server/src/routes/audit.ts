import type { FastifyPluginAsync } from 'fastify';
import { PERMISSIONS, auditQuerySchema } from '@likapcs/shared';

export const auditRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/audit-logs',
    { preHandler: app.requirePermission(PERMISSIONS.AUDIT_VIEW) },
    async (request) => {
      const query = auditQuerySchema.parse(request.query);
      return app.services.audit.query(query);
    },
  );

  app.get(
    '/audit-logs/actions',
    { preHandler: app.requirePermission(PERMISSIONS.AUDIT_VIEW) },
    async () => app.services.audit.distinctActions(),
  );
};
