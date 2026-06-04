/**
 * Org-admin audit log controller — Final Addendum §6.
 *
 * Thin layer: pull org context from req.esol_context (set by
 * requireOrgContext middleware), hand off to the service. Query
 * params travel through unchanged — the service does its own
 * validation.
 */

import { ExpressFunction } from "../interfaces/helper.interface";
import {
  listOrgAdminAuditLogService,
  OrgAdminAuditLogQuery,
} from "../services/orgAdminAuditLog.service";

export const listOrgAdminAuditLog: ExpressFunction = async (req, res, next) => {
  try {
    const orgId =
      (req as typeof req & { esol_context?: { org_id?: string } }).esol_context
        ?.org_id ??
      (req.user?.orgId as string | null | undefined) ??
      "";

    const result = await listOrgAdminAuditLogService(
      orgId,
      req.query as unknown as OrgAdminAuditLogQuery,
    );
    return res.status(result.statusCode).json({
      message: result.message,
      data: result.data,
    });
  } catch (err) {
    next(err);
  }
};
