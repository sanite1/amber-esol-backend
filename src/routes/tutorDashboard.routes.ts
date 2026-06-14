import { Router } from "express";
import { isAuthenticated, isTutor } from "../middlewares/authMiddleWare";
import { getTutorDashboardValidation } from "../validations/tutorDashboard.validation";
import { getTutorDashboard } from "../controllers/tutorDashboard.controller";

const router = Router();

// ── GET /tutor-dashboard ── (authenticated tutor only)
router.get(
  "/",
  isAuthenticated,
  isTutor,
  getTutorDashboardValidation(),
  getTutorDashboard,
);

export default router;
