/**
 * Org-admin safeguarding routes — brief Function 10.
 *
 * Mounted at /api/org-admin/safeguarding in src/index.ts.
 *
 * Org admins get ONLY a count. They never see categories, learner
 * names, alert IDs, or any per-alert detail — that visibility belongs
 * exclusively to the Amber admin / designated safeguarding lead.
 *
 * Auth: isAuthenticated + isOrgAdmin. The latter admits both
 * "org_admin" and "admin" roles for back-compat (an Amber admin can
 * still hit the count endpoint), but the service scopes to
 * req.user.orgId, which is null for Amber admins → 400. In practice
 * Amber admins use /api/admin/safeguarding for details + counts.
 */

import { Router } from "express";
import { isAuthenticated, isOrgAdmin } from "../middlewares/authMiddleWare";
import { orgAdminSafeguardingCountValidation } from "../validations/adminSafeguarding.validation";
import { getOrgAdminSafeguardingCount } from "../controllers/adminSafeguarding.controller";

const router = Router();

router.use(isAuthenticated, isOrgAdmin);

/* ── GET /api/org-admin/safeguarding/count ───────────────────────── */
router.get(
  "/count",
  isOrgAdmin,
  orgAdminSafeguardingCountValidation(),
  getOrgAdminSafeguardingCount
);

export default router;
