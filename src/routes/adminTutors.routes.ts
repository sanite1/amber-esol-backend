import { Router } from "express";
import { isAuthenticated, isAdmin } from "../middlewares/authMiddleWare";
import {
  getAdminTutorsValidation,
  updateTutorStatusValidation,
} from "../validations/adminTutors.validation";
import {
  getAdminTutors,
  updateTutorStatus,
} from "../controllers/adminTutors.controller";

const router = Router();

/* ── GET /api/admin-tutors ── */
router.get(
  "/",
  isAuthenticated,
  isAdmin,
  getAdminTutorsValidation(),
  getAdminTutors,
);

/* ── PATCH /api/admin-tutors/:id/status ── */
router.patch(
  "/:id/status",
  isAuthenticated,
  isAdmin,
  updateTutorStatusValidation(),
  updateTutorStatus,
);

export default router;
