/**
 * Admin level-change routes — brief Function 11 To-Do 2.
 *
 * Mounted at /api/admin/level-change.
 *
 * Auth: isAuthenticated + isAdmin on EVERY route. `isAdmin` explicitly
 * excludes "org_admin" — see authMiddleWare.ts. Org admins cannot
 * confirm or reject level changes; that's the Amber admin's authority
 * per Function 11. Org admins can however see the readiness flag
 * (Function 11 To-Do 1 cron sends them the in-app notification + email).
 */

import { Router } from "express";
import { isAuthenticated, isAdmin } from "../middlewares/authMiddleWare";
import {
  confirmLevelChangeValidation,
  rejectLevelChangeValidation,
} from "../validations/adminLevelChange.validation";
import {
  confirmLevelChange,
  rejectLevelChange,
} from "../controllers/adminLevelChange.controller";

const router = Router();

router.use(isAuthenticated, isAdmin);

/* ── POST /api/admin/level-change/confirm ────────────────────────── */
router.post(
  "/confirm",
  isAdmin,
  confirmLevelChangeValidation(),
  confirmLevelChange,
);

/* ── POST /api/admin/level-change/reject ─────────────────────────── */
router.post(
  "/reject",
  isAdmin,
  rejectLevelChangeValidation(),
  rejectLevelChange,
);

export default router;
