/**
 * «Skedar për AI» (0.39.0) — one file with every figure of the business, made in the background.
 * Everything here needs `reports.export_all` (owner and admin by default): the file holds far
 * more than any single report.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  DATA_EXPORT_FORMATS,
  PERMISSIONS,
  dataExportSchema,
  uuidSchema,
  type DataExportJobStarted,
  type DataExportJobStatus,
  type DataExportTicket,
} from '@likapcs/shared';
import { AppError } from '../errors.js';

/** How long a download ticket opens its one file. */
const TICKET_TTL_MS = 10 * 60 * 1000;

const CONTENT_TYPES = {
  json: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
} as const;

export const dataExportRoutes: FastifyPluginAsync = async (app) => {
  const { services } = app;
  const allowed = { preHandler: app.requirePermission(PERMISSIONS.REPORTS_EXPORT_ALL) };
  const idParams = z.object({ id: uuidSchema });
  const fileParams = z.object({ id: uuidSchema, format: z.enum(DATA_EXPORT_FORMATS) });

  /** Starts the export; the answer is the job to follow. `409 EXPORT_BUSY` while one runs. */
  app.post('/reports/data-file', allowed, async (request, reply): Promise<DataExportJobStarted> => {
    const body = dataExportSchema.parse(request.body ?? {});
    const user = request.auth!.user;
    const job = services.dataExport.start(body, {
      userId: user.id,
      label: user.username,
      ip: request.ip,
      name: user.fullName || user.username,
    });
    return reply.code(202).send({ jobId: job.id });
  });

  app.get('/reports/data-file/jobs/:id', allowed, async (request): Promise<DataExportJobStatus> =>
    services.dataExport.job(idParams.parse(request.params).id),
  );

  // A plain link cannot send the sign-in, so a link download uses a short-lived ticket instead.
  const tickets = new Map<string, { key: string; expiresAt: number }>();
  app.post(
    '/reports/data-file/:id/:format/download-ticket',
    allowed,
    async (request): Promise<DataExportTicket> => {
      const { id, format } = fileParams.parse(request.params);
      services.dataExport.file(id, format); // 404 when the file is not there (any more)
      const now = Date.now();
      for (const [key, t] of tickets) if (t.expiresAt < now) tickets.delete(key);
      const ticket = crypto.randomBytes(32).toString('base64url');
      const expiresAt = now + TICKET_TTL_MS;
      tickets.set(ticket, { key: `${id}/${format}`, expiresAt });
      return { ticket, expiresAt: new Date(expiresAt).toISOString() };
    },
  );
  const allowedOrTicket = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const { ticket } = z.object({ ticket: z.string().max(200).optional() }).parse(request.query);
    if (ticket) {
      const entry = tickets.get(ticket);
      const { id, format } = fileParams.parse(request.params);
      if (entry && entry.key === `${id}/${format}` && entry.expiresAt > Date.now()) return;
      throw new AppError(403, 'TICKET_INVALID', 'The download link has expired');
    }
    await allowed.preHandler(request, reply);
  };

  app.get(
    '/reports/data-file/:id/:format/download',
    { preHandler: allowedOrTicket },
    async (request, reply) => {
      const { id, format } = fileParams.parse(request.params);
      const file = services.dataExport.file(id, format);
      return reply
        .header('content-type', CONTENT_TYPES[format])
        .header('content-length', String(file.sizeBytes))
        .header('content-disposition', `attachment; filename="${file.fileName}"`)
        .header('cache-control', 'no-store')
        .send(fs.createReadStream(file.path));
    },
  );

  /**
   * Deletes the server's copy of the files now (they are deleted after an hour anyway). While
   * the file is still being made this cancels it: the job ends as failed, `EXPORT_CANCELLED`.
   */
  app.delete('/reports/data-file/:id', allowed, async (request, reply) => {
    await services.dataExport.delete(idParams.parse(request.params).id);
    return reply.code(204).send();
  });
};
