import type { FastifyPluginAsync } from 'fastify';
import {
  changePasswordSchema,
  userPreferencesPatchSchema,
  loginRequestSchema,
  phoneLoginSchema,
  type AuthenticatedUser,
} from '@likapcs/shared';

export const authRoutes: FastifyPluginAsync = async (app) => {
  const { services } = app;

  // Phone (PWA) login, 0.28.0: username + e-mail + password. Same lockout and audit as /auth/login.
  app.post(
    '/auth/phone-login',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request) => {
      const body = phoneLoginSchema.parse(request.body);
      return services.auth.login({
        username: body.username,
        password: body.password,
        email: body.email,
        rememberMe: body.rememberMe,
        clientApp: 'phone',
        ip: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });
    },
  );

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

  // 0.29.4: the signed-in user's own display preferences (theme, text size).
  app.get('/auth/preferences', { preHandler: app.requireAuth }, async (request) =>
    services.userPreferences.get(request.auth!.user.id),
  );
  app.put('/auth/preferences', { preHandler: app.requireAuth }, async (request) =>
    services.userPreferences.update(request.auth!.user.id, userPreferencesPatchSchema.parse(request.body)),
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
