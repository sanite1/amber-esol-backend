import { Router } from "express";
import { isAuthenticated, isAdmin } from "../middlewares/authMiddleWare";
import { getAdminDashboardValidation } from "../validations/adminDashboard.validation";
import { getAdminDashboard } from "../controllers/adminDashboard.controller";

const router = Router();

/* ── GET /api/admin-dashboard ── */
router.get(
  "/",
  isAuthenticated,
  isAdmin,
  getAdminDashboardValidation(),
  getAdminDashboard
);

export default router;
