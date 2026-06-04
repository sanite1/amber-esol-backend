/**
 * Amber-admin impersonation controller — brief Function 15.
 *
 *   POST /api/admin/impersonate/:user_id
 *
 * Auth (route layer): isAuthenticated + isAdmin.
 *
 * Thin adapter: deserialise the request, hand off to the service.
 * Passes `req` into the service so the writeAuditLog helper can read
 * any nested impersonation context (an admin who themselves arrived
 * via impersonation — rare, but handled).
 */

import { ExpressFunction } from "../interfaces/helper.interface";
import { startImpersonationService } from "../services/adminImpersonation.service";

export const startImpersonation: ExpressFunction = async (req, res, next) => {
  try {
    const { user_id } = req.params as { user_id: string };
    const adminUserId = req.user?.id?.toString() ?? "";
    const result = await startImpersonationService(user_id, adminUserId, req);
    return res.status(result.statusCode).json({
      message: result.message,
      data: result.data,
    });
  } catch (err) {
    next(err);
  }
};
