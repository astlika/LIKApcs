import type { FastifyPluginAsync } from 'fastify';
import { PERMISSIONS, reportExportQuerySchema, reportRangeSchema } from '@likapcs/shared';
import { badRequest } from '../errors.js';

export const reportRoutes: FastifyPluginAsync = async (app) => {
  const { services } = app;
  const view = { preHandler: app.requirePermission(PERMISSIONS.REPORTS_VIEW) };
  const exportPerm = { preHandler: app.requirePermission(PERMISSIONS.REPORTS_EXPORT) };
  const checkRange = (from: string, to: string) => {
    if (from > to) throw badRequest('"from" must not be after "to"');
    const days = (Date.parse(to) - Date.parse(from)) / 86_400_000;
    if (days > 366) throw badRequest('Reports cover at most one year');
  };

  app.get('/reports/sales', view, async (request) => {
    const range = reportRangeSchema.parse(request.query);
    checkRange(range.from, range.to);
    return services.reports.sales(range);
  });
  app.get('/reports/export', exportPerm, async (request, reply) => {
    const query = reportExportQuerySchema.parse(request.query);
    checkRange(query.from, query.to);
    const { filename, csv } = await services.reports.exportCsv(query.kind, query);
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="${filename}"`)
      .send(csv);
  });
};
