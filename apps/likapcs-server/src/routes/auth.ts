import type { FastifyPluginAsync } from 'fastify';
import {
  PERMISSIONS,
  changePasswordSchema,
  userPreferencesPatchSchema,
  loginRequestSchema,
  phoneLoginSchema,
  type AuthenticatedUser,
} from '@likapcs/shared';

export const authRoutes: FastifyPluginAsync = async (app) => {
  const { services } = app;
  // 0.34.0: a staff sign-in is announced to the admins who see live tracking (never fails the login).
  const signedIn = <T extends { user: { id: string; username: string; fullName: string } }>(
    via: 'phone' | 'web',
    p: Promise<T>,
  ): Promise<T> =>
    p.then((r) => {
      app.hub.broadcastToAdminsWith(PERMISSIONS.LIVE_VIEW, 'staff.login', {
        userId: r.user.id,
        username: r.user.username,
        fullName: r.user.fullName,
        via,
        at: new Date().toISOString(),
      });
      return r;
    });

  // Phone (PWA) login, 0.28.0: username + e-mail + password. Same lockout and audit as /auth/login.
  app.post(
    '/auth/phone-login',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request) => {
      const body = phoneLoginSchema.parse(request.body);
      return signedIn(
        'phone',
        services.auth.login({
          username: body.username,
          password: body.password,
          email: body.email,
          rememberMe: body.rememberMe,
          clientApp: 'phone',
          ip: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
        }),
      );
    },
  );

  app.post(
    '/auth/login',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request) => {
      const body = loginRequestSchema.parse(request.body);
      return signedIn(
        'web',
        services.auth.login({
          username: body.username,
          password: body.password,
          rememberMe: body.rememberMe,
          ip: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
        }),
      );
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
    services.userPreferences.update(
      request.auth!.user.id,
      userPreferencesPatchSchema.parse(request.body),
    ),
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
