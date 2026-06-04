/**
 * Org-admin audit log route — Final Addendum §6.
 *
 * Mounted at /api/org-admin/audit-log.
 *
 * Auth chain matches the rest of the org-admin family:
 *   isAuthenticated     → JWT valid + account active
 *   isOrgAdmin          → role is org_admin or admin
 *   requireOrgContext   → req.user.orgId is set, attached to
 *                         req.esol_context.org_id (Amber admins with
 *                         no orgId are rejected with 403)
 */

import { Router } from "express";
import { isAuthenticated, isOrgAdmin } from "../middlewares/authMiddleWare";
import { requireOrgContext } from "../middlewares/orgScopingMiddleware";
import { orgAdminAuditLogValidation } from "../validations/orgAdminAuditLog.validation";
import { listOrgAdminAuditLog } from "../controllers/orgAdminAuditLog.controller";

const router = Router();

router.use(isAuthenticated, isOrgAdmin, requireOrgContext);

router.get("/", orgAdminAuditLogValidation(), listOrgAdminAuditLog);

export default router;
