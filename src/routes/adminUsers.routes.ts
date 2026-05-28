import { Router } from "express";
import { isAuthenticated, isAdmin } from "../middlewares/authMiddleWare";
import {
  adminApproveEsolValidation,
  rejectTeacherValidation,
} from "../validations/esolTeacher.validation";
import {
  adminApproveEsolTeacher,
  adminRejectEsolTeacher,
} from "../controllers/esolTeacher.controller";

/**
 * Admin user-management routes — the brief §2 Change 2 specifies these
 * exact paths under /api/admin/users/...:
 *
 *   PATCH /api/admin/users/:id/approve-esol-teacher
 *   PATCH /api/admin/users/:id/reject-esol-teacher
 *
 * Implementation re-uses the esolTeacher service layer so the existing
 * POST /api/esol/teachers/:tutorId/approve and revoke endpoints keep
 * working. The two routes here are the admin-facing canonical paths;
 * the older esol/teachers routes are kept for back-compat with any
 * frontend code already calling them.
 */

const router = Router();

router.use(isAuthenticated, isAdmin);

router.patch(
  "/:id/approve-esol-teacher",
  adminApproveEsolValidation(),
  adminApproveEsolTeacher
);

router.patch(
  "/:id/reject-esol-teacher",
  rejectTeacherValidation(),
  adminRejectEsolTeacher
);

export default router;
