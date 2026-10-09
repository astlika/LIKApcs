import fp from 'fastify-plugin';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { PermissionCode } from '@likapcs/shared';
import { forbidden, unauthorized } from '../errors.js';
import type { AuthContext } from '../services/auth.js';

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
  interface FastifyInstance {
    requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requirePermission: (
      ...codes: PermissionCode[]
    ) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export function extractBearer(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) return null;
  return token.trim();
}

/** Resolves the bearer token (if any) on every request and exposes auth guards. */
export default fp(async (app) => {
  app.decorateRequest('auth', null);

  app.addHook('onRequest', async (request) => {
    const token = extractBearer(request.headers.authorization);
    request.auth = token ? await app.services.auth.resolveToken(token) : null;
  });

  app.decorate('requireAuth', async (request: FastifyRequest) => {
    if (!request.auth) throw unauthorized();
  });

  app.decorate('requirePermission', (...codes: PermissionCode[]) => {
    return async (request: FastifyRequest) => {
      if (!request.auth) throw unauthorized();
      for (const code of codes) {
        if (!request.auth.permissions.has(code)) throw forbidden(`Missing permission: ${code}`);
      }
    };
  });
});
