/**
 * Backups & restore — everything here needs `backups.manage` (Owner / Administrator by default).
 * A restore additionally re-checks the caller's password and an explicit `confirm: true`.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import type { Readable } from 'node:stream';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  PERMISSIONS,
  backupEncryptionSchema,
  backupFileSchema,
  backupListQuerySchema,
  backupUploadQuerySchema,
  restoreBackupSchema,
  transferExportSchema,
  uuidSchema,
  type BackupDownloadTicket,
  type BackupJobStarted,
  type BackupJobStatus,
} from '@likapcs/shared';
import { AppError } from '../errors.js';

/**
 * Uploaded archives can be large; everything else on the API keeps the 1 MB default. The body is
 * written straight to the backup folder, never held in memory. 0.38.0: 64 GB instead of 4 GB (a
 * shop with many ad videos passed the old limit).
 */
export const BACKUP_UPLOAD_LIMIT_BYTES = 64 * 1024 * 1024 * 1024;
const UPLOAD_LIMIT_BYTES = BACKUP_UPLOAD_LIMIT_BYTES;
/** How long a download ticket opens its one archive. */
const TICKET_TTL_MS = 10 * 60 * 1000;

/**
 * The password of an uploaded archive. `x-archive-password-utf8` (0.38.0) carries it
 * percent-encoded, so a password with letters outside Latin-1 arrives intact (a header value can
 * only hold single bytes); `x-archive-password` is the older, plain form.
 */
export function archivePasswordHeader(request: FastifyRequest): string | undefined {
  const encoded = request.headers['x-archive-password-utf8'];
  if (typeof encoded === 'string' && encoded.length > 0) {
    try {
      return decodeURIComponent(encoded).slice(0, 200);
    } catch {
      throw new AppError(400, 'validation_error', 'x-archive-password-utf8 is not valid');
    }
  }
  const plain = request.headers['x-archive-password'];
  return typeof plain === 'string' && plain.length > 0 ? plain.slice(0, 200) : undefined;
}

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

  // Backup password status (0.26.0). The password itself is never returned.
  app.get('/backups/encryption', manage, async () => services.backups.encryptionStatus());

  app.put('/backups/encryption', manage, async (request) => {
    const body = backupEncryptionSchema.parse(request.body);
    const auth = request.auth!;
    const ok = await services.auth.confirmPassword(auth.user.id, body.password);
    if (!ok) throw new AppError(403, 'PASSWORD_MISMATCH', 'The password is not correct');
    return services.backups.setEncryption({
      archivePassword: body.archivePassword,
      actor: actorOf(request),
    });
  });

  app.post('/backups', manage, async (request, reply) => {
    const backup = await services.backups.create({ kind: 'manual', actor: actorOf(request) });
    return reply.code(201).send(backup);
  });

  // ─── Backup file with a loading bar (0.38.0) ───────────────────────────────
  /**
   * «Backup file»: starts a complete backup (database + every uploaded file, read back and
   * checked) in the background. The answer is the job to follow; the archive is an ordinary
   * manual backup in the list, downloaded like any other.
   */
  app.post('/backups/file', manage, async (request, reply): Promise<BackupJobStarted> => {
    const body = backupFileSchema.parse(request.body ?? {});
    const job = services.backups.startBackupJob({
      actor: actorOf(request),
      password: body.password,
    });
    return reply.code(202).send({ jobId: job.id });
  });

  /**
   * Progress of a backup or restore started above. No sign-in: the id is the key, and the answer
   * comes from memory, so it also arrives while a restore holds every table of the database
   * (a signed-in request would wait for the restore to end before it could be checked).
   */
  app.get('/backups/jobs/:id', async (request): Promise<BackupJobStatus> =>
    services.backups.job(idParams.parse(request.params).id),
  );

  // A plain link cannot send the sign-in, so a link download uses a short-lived ticket instead.
  const tickets = new Map<string, { backupId: string; expiresAt: number }>();
  app.post(
    '/backups/:id/download-ticket',
    manage,
    async (request): Promise<BackupDownloadTicket> => {
      const { id } = idParams.parse(request.params);
      await services.backups.file(id); // 404 when the archive is not there
      const now = Date.now();
      for (const [key, t] of tickets) if (t.expiresAt < now) tickets.delete(key);
      const ticket = crypto.randomBytes(32).toString('base64url');
      const expiresAt = now + TICKET_TTL_MS;
      tickets.set(ticket, { backupId: id, expiresAt });
      return { ticket, expiresAt: new Date(expiresAt).toISOString() };
    },
  );
  const manageOrTicket = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const { ticket } = z.object({ ticket: z.string().max(200).optional() }).parse(request.query);
    if (ticket) {
      const entry = tickets.get(ticket);
      const { id } = idParams.parse(request.params);
      if (entry && entry.backupId === id && entry.expiresAt > Date.now()) return;
      throw new AppError(403, 'TICKET_INVALID', 'The download link has expired');
    }
    await manage.preHandler(request, reply);
  };

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
      // The backup password (only for encrypted files) travels in a header, never in the URL.
      const archivePassword = archivePasswordHeader(request);
      const backup = await services.backups.importUpload(
        body as unknown as Readable,
        fileName,
        actorOf(request),
        archivePassword,
      );
      return reply.code(201).send(backup);
    },
  );

  // USB transfer (0.27.5): the whole system into one file encrypted with a 4-digit code.
  app.post('/backups/transfer', manage, async (request) => {
    const body = transferExportSchema.parse(request.body);
    const auth = request.auth!;
    const ok = await services.auth.confirmPassword(auth.user.id, body.password);
    if (!ok) throw new AppError(403, 'PASSWORD_MISMATCH', 'The password is not correct');
    return services.backups.exportTransfer({
      code: body.code,
      targetDir: body.targetDir,
      actor: actorOf(request),
    });
  });

  app.get('/backups/:id', manage, async (request) =>
    services.backups.get(idParams.parse(request.params).id),
  );

  app.get('/backups/:id/download', { preHandler: manageOrTicket }, async (request, reply) => {
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
    return services.backups.restore({
      id,
      actor: actorOf(request),
      sessionId: auth.sessionId,
      archivePassword: body.archivePassword,
    });
  });

  /**
   * The same restore, in the background (0.38.0): the answer is the job to follow with
   * `GET /backups/jobs/:id`, which reports the percentage and, at the end, what was restored.
   */
  app.post(
    '/backups/:id/restore-job',
    manage,
    async (request, reply): Promise<BackupJobStarted> => {
      const { id } = idParams.parse(request.params);
      const body = restoreBackupSchema.parse(request.body);
      const auth = request.auth!;
      const ok = await services.auth.confirmPassword(auth.user.id, body.password);
      if (!ok) throw new AppError(403, 'PASSWORD_MISMATCH', 'The password is not correct');
      // Answered at once, not inside the job: no such file, a missing or wrong file password, a
      // file made by a newer version.
      await services.backups.inspect(id, body.archivePassword);
      const job = services.backups.startRestoreJob({
        id,
        actor: actorOf(request),
        sessionId: auth.sessionId,
        archivePassword: body.archivePassword,
      });
      return reply.code(202).send({ jobId: job.id });
    },
  );
};
