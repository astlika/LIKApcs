/**
 * Import from another program (LIKApos Pro backup JSON) — `backups.manage` only.
 *
 *   POST /imports/analyze  { data }                         → ImportAnalysis (nothing is written)
 *   POST /imports/run      { data, entities[], dryRun }     → ImportReport  (dry run rolls back)
 *   GET  /imports/status                                    → last run + picture download progress
 *
 * The whole backup travels in the request body (a few MB), so these two routes get their own
 * body limit; the rest of the API keeps the 1 MB default.
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { PERMISSIONS, importRunOptionsSchema } from '@likapcs/shared';

const IMPORT_BODY_LIMIT = 256 * 1024 * 1024;

export const importRoutes: FastifyPluginAsync = async (app) => {
  const { services } = app;
  const actorOf = (request: FastifyRequest) => ({
    userId: request.auth!.user.id,
    label: request.auth!.user.username,
    ip: request.ip,
  });
  const manage = { preHandler: app.requirePermission(PERMISSIONS.BACKUPS_MANAGE) };
  const envelope = z.object({ data: z.unknown() });

  app.post('/imports/analyze', { ...manage, bodyLimit: IMPORT_BODY_LIMIT }, async (request) => {
    const { data } = envelope.parse(request.body);
    return services.imports.analyze(data);
  });

  app.post('/imports/run', { ...manage, bodyLimit: IMPORT_BODY_LIMIT }, async (request) => {
    const { data } = envelope.parse(request.body);
    const options = importRunOptionsSchema.parse(request.body);
    return services.imports.run(data, options, actorOf(request));
  });

  app.get('/imports/status', manage, async () => services.imports.status());
};
