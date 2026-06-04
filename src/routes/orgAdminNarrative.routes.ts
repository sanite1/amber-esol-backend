/**
 * Org-admin narrative summary route — brief Function 12 To-Do 3.
 *
 * Mounted at /api/org-admin/narrative-summary.
 *
 * Auth chain matches the brief:
 *   isAuthenticated     → JWT valid + account active
 *   isOrgAdmin          → role is org_admin or admin
 *   requireOrgContext   → req.user.orgId is set, attached to
 *                         req.esol_context.org_id (Amber admins with
 *                         no orgId are rejected with 403; they use
 *                         the /api/admin/* endpoints for cross-org
 *                         analytics)
 *
 * No query params — the narrative is always "the last 28 days for
 * this org". A future dashboard refinement could add a date-range
 * override but the brief intentionally keeps the v1 surface simple
 * so the cache key stays trivial.
 */

import { Router } from "express";
import { isAuthenticated, isOrgAdmin } from "../middlewares/authMiddleWare";
import { requireOrgContext } from "../middlewares/orgScopingMiddleware";
import { getCohortNarrativeSummary } from "../controllers/narrativeSummary.controller";

const router = Router();

router.use(isAuthenticated, isOrgAdmin, requireOrgContext);

router.get("/", getCohortNarrativeSummary);

export default router;
