/**
 * Admin safeguarding routes — brief Function 10 / Function 15.
 *
 * Mounted at /api/admin/safeguarding in src/index.ts.
 *
 * Auth: isAuthenticated + isAdmin on EVERY route.
 *
 *   - isAuthenticated  → JWT valid + account active + org context fresh
 *   - isAdmin          → role MUST equal "admin". The middleware
 *                        explicitly excludes "org_admin" — see
 *                        authMiddleWare.ts. Org admins land at the
 *                        sibling router (adminSafeguardingOrgAdmin.routes).
 *
 * Endpoints:
 *   GET    /                 list alerts (paginated, filterable)
 *                            Function 15 To-Do 2 additions:
 *                              ?summary=true  switches the response
 *                                             to aggregate counts
 *                                             (by category, by org,
 *                                             unresolved >24h, avg
 *                                             time to resolve).
 *                              ?days=N        windows BOTH the list
 *                                             and the summary to the
 *                                             last N days (1–365).
 *   GET    /:id              alert detail
 *   PATCH  /:id              resolve an alert
 */

import { Router } from "express";
import { isAuthenticated, isAdmin } from "../middlewares/authMiddleWare";
import {
  listAdminSafeguardingValidation,
  adminSafeguardingIdParamValidation,
  resolveAdminSafeguardingValidation,
} from "../validations/adminSafeguarding.validation";
import {
  listAdminSafeguardingAlerts,
  getAdminSafeguardingAlert,
  resolveAdminSafeguardingAlert,
} from "../controllers/adminSafeguarding.controller";

const router = Router();

// Gate the entire router on Amber-admin role. Defence in depth: the
// per-route middlewares restate isAdmin so a future refactor can't
// remove the gate accidentally.
router.use(isAuthenticated, isAdmin);

/* ── GET /api/admin/safeguarding ─────────────────────────────────── */
router.get("/", isAdmin, listAdminSafeguardingValidation(), listAdminSafeguardingAlerts);

/* ── GET /api/admin/safeguarding/:id ─────────────────────────────── */
router.get(
  "/:id",
  isAdmin,
  adminSafeguardingIdParamValidation(),
  getAdminSafeguardingAlert
);

/* ── PATCH /api/admin/safeguarding/:id ───────────────────────────── */
router.patch(
  "/:id",
  isAdmin,
  resolveAdminSafeguardingValidation(),
  resolveAdminSafeguardingAlert
);

export default router;
