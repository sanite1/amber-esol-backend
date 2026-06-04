/**
 * Admin GLH analytics controller — Final Addendum §12.
 *
 *   GET /api/admin/glh-analytics?from&to&org_id
 *
 * Thin adapter — hands the query through to the service. Auth +
 * role gate are mounted at the route layer (isAuthenticated +
 * isAdmin).
 */

import { ExpressFunction } from "../interfaces/helper.interface";
import {
  getGlhAnalyticsService,
  GlhAnalyticsQuery,
} from "../services/adminGlhAnalytics.service";

export const getGlhAnalytics: ExpressFunction = async (req, res, next) => {
  try {
    const result = await getGlhAnalyticsService(
      req.query as unknown as GlhAnalyticsQuery,
    );
    return res.status(result.statusCode).json({
      message: result.message,
      data: result.data,
    });
  } catch (err) {
    next(err);
  }
};
