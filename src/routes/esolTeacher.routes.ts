import { Router } from "express";
import {
  isAuthenticated,
  isAdmin,
  isOrgAdmin,
  isTutor,
} from "../middlewares/authMiddleWare";
import {
  listTeachersValidation,
  tutorIdParamValidation,
  approveTeacherValidation,
  updateQualificationsValidation,
} from "../validations/esolTeacher.validation";
import {
  listEsolTeachers,
  approveTeacher,
  updateTeacherQualifications,
  revokeTeacherApproval,
} from "../controllers/esolTeacher.controller";
import { NextFunction, Request, Response } from "express";
import { IUserDecoded } from "../middlewares/authMiddleWare";

// Allows access to admin, org_admin, OR the tutor themselves (for qualifications)
const isAdminOrgAdminOrSelf = (
  req: Request & { user?: IUserDecoded },
  _res: Response,
  next: NextFunction
) => {
  const role = req.user?.role;
  const isSelf =
    role === "tutor" && req.user?.id.toString() === req.params.tutorId;
  if (role === "admin" || role === "org_admin" || isSelf) {
    return next();
  }
  return next(
    new (require("../errors/apiError").default)(403, "Access denied")
  );
};

const router = Router();

router.use(isAuthenticated);

// List ESOL teachers (admin | org_admin)
router.get("/", isOrgAdmin, listTeachersValidation(), listEsolTeachers);

// Approve teacher (admin only)
router.post(
  "/:tutorId/approve",
  isAdmin,
  approveTeacherValidation(),
  approveTeacher
);

// Update qualifications (tutor self | admin)
router.patch(
  "/:tutorId/qualifications",
  isAdminOrgAdminOrSelf,
  updateQualificationsValidation(),
  updateTeacherQualifications
);

// Revoke ESOL approval (admin only)
router.delete(
  "/:tutorId/approve",
  isAdmin,
  tutorIdParamValidation(),
  revokeTeacherApproval
);

export default router;
