import type { FastifyPluginAsync } from 'fastify';
import { searchQuerySchema } from '@likapcs/shared';

/** `GET /search?q=` — any signed-in user; every kind is filtered by that user's permissions. */
export const searchRoutes: FastifyPluginAsync = async (app) => {
  app.get('/search', { preHandler: app.requireAuth }, async (request) => {
    const { q, limit } = searchQuerySchema.parse(request.query);
    return app.services.search.search(q, limit, request.auth!.permissions);
  });
};
