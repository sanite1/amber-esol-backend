/**
 * Amber-admin cross-organisation audit search — Final Addendum §6.
 *
 * Mounted at /api/admin/audit-log. Amber admin ONLY — this is the one
 * audit surface that is not org-scoped, so the role gate is the whole
 * privacy boundary.
 *
 *   GET /   ?org_id=&learner_id=&action=&from=&to=&page=&limit=
 */

import { Router } from "express";
import { isAuthenticated, isAdmin } from "../middlewares/authMiddleWare";
import { listAdminAuditLog } from "../controllers/adminAuditLog.controller";

const router = Router();

router.use(isAuthenticated, isAdmin);

router.get("/", listAdminAuditLog);

export default router;
