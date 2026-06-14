import { Router } from "express";
import { isAuthenticated, isAdmin } from "../middlewares/authMiddleWare";
import {
  getAdminStudentsValidation,
  updateStudentStatusValidation,
} from "../validations/adminStudents.validation";
import {
  getAdminStudents,
  updateStudentStatus,
} from "../controllers/adminStudents.controller";

const router = Router();

/* ── GET /api/admin-students ── */
router.get(
  "/",
  isAuthenticated,
  isAdmin,
  getAdminStudentsValidation(),
  getAdminStudents,
);

/* ── PATCH /api/admin-students/:id/status ── */
router.patch(
  "/:id/status",
  isAuthenticated,
  isAdmin,
  updateStudentStatusValidation(),
  updateStudentStatus,
);

export default router;
