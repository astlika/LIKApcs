import type { FastifyPluginAsync } from 'fastify';
import { changePasswordSchema, loginRequestSchema, type AuthenticatedUser } from '@likapcs/shared';

export const authRoutes: FastifyPluginAsync = async (app) => {
  const { services } = app;

  app.post(
    '/auth/login',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request) => {
      const body = loginRequestSchema.parse(request.body);
      return services.auth.login({
        username: body.username,
        password: body.password,
        rememberMe: body.rememberMe,
        ip: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });
    },
  );

  app.post('/auth/logout', { preHandler: app.requireAuth }, async (request, reply) => {
    await services.auth.logout(request.auth!, request.ip);
    return reply.status(204).send();
  });

  app.get(
    '/auth/me',
    { preHandler: app.requireAuth },
    async (request): Promise<AuthenticatedUser> => {
      return request.auth!.user;
    },
  );

  app.post('/auth/change-password', { preHandler: app.requireAuth }, async (request, reply) => {
    const body = changePasswordSchema.parse(request.body);
    const ctx = request.auth!;
    await services.users.changeOwnPassword(
      ctx.user.id,
      body.currentPassword,
      body.newPassword,
      ctx.sessionId,
      {
        userId: ctx.user.id,
        label: ctx.user.username,
        ip: request.ip,
      },
    );
    return reply.status(204).send();
  });
};
