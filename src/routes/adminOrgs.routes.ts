/**
 * Amber-admin org-management routes — brief Function 15.
 *
 * Mounted at /api/admin/orgs.
 *
 * Auth chain — Amber admin only (no org context):
 *   isAuthenticated → JWT valid + account active
 *   isAdmin         → role === "admin" (Amber super-admin)
 *
 * Endpoints:
 *   GET  /overview   Function 15 To-Do 1 — all-orgs dashboard payload
 *
 * Future additions (Function 15 To-Dos 2–5) — org detail, billing
 * actions, demo toggle — will land on this router. Keeping a
 * dedicated `admin/orgs` mount makes those sit naturally without
 * needing a second router.
 */

import { Router } from "express";
import { isAuthenticated, isAdmin } from "../middlewares/authMiddleWare";
import { getAdminOrgsOverviewController } from "../controllers/adminOrgsOverview.controller";
import {
  getMisSettings,
  updateMisSettings,
  testMisConnection,
} from "../controllers/adminMisSettings.controller";
import {
  updateMisSettingsValidation,
  testMisConnectionValidation,
} from "../validations/adminMisSettings.validation";

const router = Router();

router.use(isAuthenticated, isAdmin);

router.get("/overview", getAdminOrgsOverviewController);

// Final Addendum §7 — MIS settings management
router.get("/:id/mis-settings", getMisSettings);
router.patch(
  "/:id/mis-settings",
  updateMisSettingsValidation(),
  updateMisSettings,
);
router.post(
  "/:id/mis-test-connection",
  testMisConnectionValidation(),
  testMisConnection,
);

export default router;
