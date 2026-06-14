/**
 * Org-admin teacher assignment routes — brief Final Addendum §4.
 *
 * Mounted at /api/org-admin/teachers. The PATCH learner→teacher
 * endpoint lives under /api/org-admin/learners/:learnerId/teacher and
 * is added to the existing orgAdminLearners router so the URL space
 * stays organised by resource.
 *
 * Auth: isAuthenticated + isOrgAdmin + requireOrgContext on every
 * route. The org context is the source of truth — Amber admins with
 * no orgId are rejected at the middleware layer.
 */

import { Router } from "express";
import { isAuthenticated, isOrgAdmin } from "../middlewares/authMiddleWare";
import { requireOrgContext } from "../middlewares/orgScopingMiddleware";
import { teacherIdParamValidation } from "../validations/teacherAssignment.validation";
import {
  listOrgTeachers,
  addTeacherToOrg,
  removeTeacherFromOrg,
} from "../controllers/teacherAssignment.controller";
import { autoAssignUnassigned } from "../controllers/teacherMatching.controller";

const router = Router();

router.use(isAuthenticated, isOrgAdmin, requireOrgContext);

/* ── GET /api/org-admin/teachers ─────────────────────────────────── */
router.get("/", listOrgTeachers);

/* ── POST /api/org-admin/teachers/auto-assign ────────────────────────
 * Bulk best-match assignment for every unassigned learner in the org.
 * MUST stay above the :teacherId param routes — Express would
 * otherwise read "auto-assign" as a teacher id. */
router.post("/auto-assign", autoAssignUnassigned);

/* ── POST /api/org-admin/teachers/:teacherId ─────────────────────── */
router.post("/:teacherId", teacherIdParamValidation(), addTeacherToOrg);

/* ── DELETE /api/org-admin/teachers/:teacherId ───────────────────── */
router.delete("/:teacherId", teacherIdParamValidation(), removeTeacherFromOrg);

export default router;
