/**
 * Backups & restore — everything here needs `backups.manage` (Owner / Administrator by default).
 * A restore additionally re-checks the caller's password and an explicit `confirm: true`.
 */
import fs from 'node:fs';
import type { Readable } from 'node:stream';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  PERMISSIONS,
  backupListQuerySchema,
  backupUploadQuerySchema,
  restoreBackupSchema,
  uuidSchema,
} from '@likapcs/shared';
import { AppError } from '../errors.js';

/** Uploaded archives can be large; everything else on the API keeps the 1 MB default. */
const UPLOAD_LIMIT_BYTES = 4 * 1024 * 1024 * 1024;

export const backupRoutes: FastifyPluginAsync = async (app) => {
  const { services } = app;
  const idParams = z.object({ id: uuidSchema });
  const actorOf = (request: FastifyRequest) => ({
    userId: request.auth!.user.id,
    label: request.auth!.user.username,
    ip: request.ip,
  });
  const manage = { preHandler: app.requirePermission(PERMISSIONS.BACKUPS_MANAGE) };

  // Raw body for uploads (scoped to this plugin).
  app.addContentTypeParser(
    ['application/octet-stream', 'application/gzip', 'application/x-gzip'],
    (_request, payload, done) => done(null, payload),
  );

  app.get('/backups', manage, async (request) =>
    services.backups.list(backupListQuerySchema.parse(request.query)),
  );

  app.post('/backups', manage, async (request, reply) => {
    const backup = await services.backups.create({ kind: 'manual', actor: actorOf(request) });
    return reply.code(201).send(backup);
  });

  app.post(
    '/backups/upload',
    { ...manage, bodyLimit: UPLOAD_LIMIT_BYTES },
    async (request, reply) => {
      const { fileName } = backupUploadQuerySchema.parse(request.query);
      const body = request.body as NodeJS.ReadableStream | undefined;
      if (!body || typeof (body as { pipe?: unknown }).pipe !== 'function') {
        throw new AppError(
          415,
          'unsupported_media_type',
          'Send the archive as application/octet-stream',
        );
      }
      const backup = await services.backups.importUpload(
        body as unknown as Readable,
        fileName,
        actorOf(request),
      );
      return reply.code(201).send(backup);
    },
  );

  app.get('/backups/:id', manage, async (request) =>
    services.backups.get(idParams.parse(request.params).id),
  );

  app.get('/backups/:id/download', manage, async (request, reply) => {
    const file = await services.backups.file(idParams.parse(request.params).id);
    return reply
      .header('content-type', 'application/gzip')
      .header('content-length', String(file.sizeBytes))
      .header('content-disposition', `attachment; filename="${file.fileName}"`)
      .send(fs.createReadStream(file.path));
  });

  app.delete('/backups/:id', manage, async (request) =>
    services.backups.delete(idParams.parse(request.params).id, actorOf(request)),
  );

  app.post('/backups/:id/restore', manage, async (request) => {
    const { id } = idParams.parse(request.params);
    const body = restoreBackupSchema.parse(request.body);
    const auth = request.auth!;
    const ok = await services.auth.confirmPassword(auth.user.id, body.password);
    if (!ok) throw new AppError(403, 'PASSWORD_MISMATCH', 'The password is not correct');
    return services.backups.restore({ id, actor: actorOf(request), sessionId: auth.sessionId });
  });
};
