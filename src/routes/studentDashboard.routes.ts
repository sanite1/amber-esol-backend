import { Router } from "express";
import { isAuthenticated, isStudent } from "../middlewares/authMiddleWare";
import { getStudentDashboardValidation } from "../validations/studentDashboard.validation";
import { getStudentDashboard } from "../controllers/studentDashboard.controller";

const router = Router();

/* ── GET /api/student-dashboard ── */
router.get(
  "/",
  isAuthenticated,
  isStudent,
  getStudentDashboardValidation(),
  getStudentDashboard,
);

export default router;
