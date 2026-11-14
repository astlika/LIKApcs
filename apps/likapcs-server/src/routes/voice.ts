import fs from 'node:fs';
import type { Readable } from 'node:stream';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { PERMISSIONS, VOICE_SLOT_PATTERN, VOICE_UPLOAD_MAX_BYTES } from '@likapcs/shared';
import { AppError } from '../errors.js';

/** What a browser may call an audio file; the server looks at the bytes, not at this. */
const UPLOAD_TYPES = [
  'application/octet-stream',
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/x-wav',
  'audio/wave',
  'audio/ogg',
  'audio/mp4',
  'audio/x-m4a',
  'audio/aac',
];

/**
 * 0.35.0: the owner's own recordings for the spoken time warnings on the PCs.
 *
 * - `PUT /client/voice/:slot?name=` — raw audio body (MP3, WAV, OGG, M4A; ≤ 2 MB) for one
 *   announcement: `5`, `1` … (minutes left) or `up` (the time ran out).
 * - `DELETE /client/voice/:slot` — back to the built-in voice.
 * - `GET /files/voice/:name` — public, read-only: the PCs fetch the recording with a plain request.
 */
export const voiceRoutes: FastifyPluginAsync = async (app) => {
  const { services } = app;
  const manageSettings = { preHandler: app.requirePermission(PERMISSIONS.SETTINGS_MANAGE) };
  const slotParams = z.object({ slot: z.string().regex(VOICE_SLOT_PATTERN) });
  const actorOf = (request: FastifyRequest) => ({
    userId: request.auth!.user.id,
    label: request.auth!.user.username,
    ip: request.ip,
  });
  // Raw bodies for the uploads (scoped to this plugin, like product pictures).
  app.addContentTypeParser(UPLOAD_TYPES, (_request, payload, done) => done(null, payload));

  app.put(
    '/client/voice/:slot',
    { ...manageSettings, bodyLimit: VOICE_UPLOAD_MAX_BYTES },
    async (request) => {
      const { slot } = slotParams.parse(request.params);
      const { name } = z.object({ name: z.string().max(300).optional() }).parse(request.query);
      const body = request.body as NodeJS.ReadableStream | undefined;
      if (!body || typeof (body as { pipe?: unknown }).pipe !== 'function') {
        throw new AppError(
          415,
          'unsupported_media_type',
          'Send the recording as an audio file (MP3, WAV, OGG or M4A)',
        );
      }
      const custom = await services.voice.setCustom(
        slot,
        body as unknown as Readable,
        name,
        actorOf(request),
      );
      return { custom };
    },
  );

  app.delete('/client/voice/:slot', manageSettings, async (request) => {
    const { slot } = slotParams.parse(request.params);
    return { custom: await services.voice.removeCustom(slot, actorOf(request)) };
  });

  /**
   * Public, read-only. Names are random and unguessable, and only our own files can be addressed
   * (see VoiceClipStore.resolve). A replaced recording gets a new name, so this caches forever.
   */
  app.get('/files/voice/:name', async (request, reply) => {
    const { name } = z.object({ name: z.string().min(1).max(64) }).parse(request.params);
    const file = services.voice.clips.resolve(name);
    if (!file || !services.voice.clips.exists(name)) {
      throw new AppError(404, 'not_found', 'File not found');
    }
    return reply
      .header('content-type', file.contentType)
      .header('cache-control', 'public, max-age=31536000, immutable')
      .send(fs.createReadStream(file.path));
  });
};
