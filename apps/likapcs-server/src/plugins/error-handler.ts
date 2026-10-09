import fp from 'fastify-plugin';
import type { FastifyError } from 'fastify';
import { ZodError } from 'zod';
import type { ApiErrorBody } from '@likapcs/shared';
import { AppError } from '../errors.js';

/** Maps every thrown error to a consistent JSON body; never leaks stack traces to clients. */
export default fp(async (app) => {
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof ZodError) {
      const body: ApiErrorBody = {
        error: {
          code: 'validation_error',
          message: 'Request validation failed',
          details: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
      };
      return reply.status(400).send(body);
    }
    if (error instanceof AppError) {
      const body: ApiErrorBody = {
        error: { code: error.code, message: error.message, details: error.details },
      };
      return reply.status(error.statusCode).send(body);
    }
    const statusCode = typeof error.statusCode === 'number' ? error.statusCode : 500;
    if (statusCode === 429) {
      return reply.status(429).send({
        error: { code: 'rate_limited', message: 'Too many requests. Please wait a moment.' },
      });
    }
    if (statusCode >= 400 && statusCode < 500) {
      return reply
        .status(statusCode)
        .send({ error: { code: error.code ?? 'bad_request', message: error.message } });
    }
    request.log.error({ err: error, url: request.url }, 'unhandled error');
    return reply
      .status(500)
      .send({ error: { code: 'internal_error', message: 'Internal server error' } });
  });

  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send({
      error: { code: 'not_found', message: `Route ${request.method} ${request.url} not found` },
    });
  });
});
