import { Router } from "express";
import { isAuthenticated, isAdmin } from "../middlewares/authMiddleWare";
import {
  logCalibration,
  deleteCalibration,
  summariseCalibration,
} from "../controllers/calibration.controller";

/**
 * Placement calibration admin routes — brief Function 6 To-Do 5.
 *
 *   POST   /api/admin/calibration/log       — record one outcome row
 *   GET    /api/admin/calibration/summary   — drive the /admin/calibration dashboard
 *   DELETE /api/admin/calibration/log/:id   — scrub a row recorded in error
 *
 * Auth: isAuthenticated + isAdmin. Calibration is platform-level
 * tooling for Joey's launch sign-off; org admins never see this surface.
 *
 * The summary endpoint accepts `?bank_version=N` to pull a prior run's
 * roll-up. Default: the bank version currently loaded on disk.
 */
const router = Router();

router.post("/log", isAuthenticated, isAdmin, logCalibration);
router.delete("/log/:id", isAuthenticated, isAdmin, deleteCalibration);
router.get("/summary", isAuthenticated, isAdmin, summariseCalibration);

export default router;
