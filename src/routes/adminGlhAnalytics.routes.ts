/**
 * Admin GLH analytics route — Final Addendum §12.
 *
 * Mounted at `/api/admin/glh-analytics` in src/index.ts.
 *
 * Auth chain (every route):
 *   isAuthenticated → JWT valid + account active
 *   isAdmin         → role === "admin" (Amber super-admin only)
 *
 * Org admins cannot see this view — it's a cross-platform
 * leaderboard. Per-org self-service analytics live under the
 * /api/org-admin/* prefix.
 */

import { Router } from "express";
import { isAdmin, isAuthenticated } from "../middlewares/authMiddleWare";
import { getGlhAnalytics } from "../controllers/adminGlhAnalytics.controller";
import { glhAnalyticsValidation } from "../validations/adminGlhAnalytics.validation";

const router = Router();

router.use(isAuthenticated, isAdmin);

// GET /api/admin/glh-analytics?from&to&org_id
router.get("/", glhAnalyticsValidation(), getGlhAnalytics);

export default router;
