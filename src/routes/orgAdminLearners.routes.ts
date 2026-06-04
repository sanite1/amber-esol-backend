/**
 * Org-admin learners routes — brief Function 12 To-Do 1.
 *
 * Mounted at /api/org-admin/learners.
 *
 * Auth chain:
 *   isAuthenticated     → JWT valid + account active
 *   isOrgAdmin          → role is org_admin or admin
 *   requireOrgContext   → req.user.orgId is set, attached to
 *                         req.esol_context.org_id
 *
 * For an Amber admin (no orgId on the JWT), requireOrgContext returns
 * 403 — Amber admins use /api/admin/* endpoints for cross-org data.
 */

import { Router } from "express";
import { isAuthenticated, isOrgAdmin } from "../middlewares/authMiddleWare";
import { requireOrgContext } from "../middlewares/orgScopingMiddleware";
import { cohortTableValidation } from "../validations/cohortTable.validation";
import { learnerDetailValidation } from "../validations/learnerDetail.validation";
import { nudgeLearnerValidation } from "../validations/learnerNudge.validation";
import { assignTeacherToLearnerValidation } from "../validations/teacherAssignment.validation";
import { getOrgAdminCohortTable } from "../controllers/cohortTable.controller";
import { getOrgAdminLearnerDetail } from "../controllers/learnerDetail.controller";
import { nudgeLearner } from "../controllers/learnerNudge.controller";
import { assignTeacherToLearner } from "../controllers/teacherAssignment.controller";

const router = Router();

router.use(isAuthenticated, isOrgAdmin, requireOrgContext);

/* ── GET /api/org-admin/learners ─────────────────────────────────── */
router.get("/", cohortTableValidation(), getOrgAdminCohortTable);

/* ── GET /api/org-admin/learners/:id (Function 12 To-Do 2) ───────── */
router.get("/:id", learnerDetailValidation(), getOrgAdminLearnerDetail);

/* ── POST /api/org-admin/learners/:id/nudge (Function 12 To-Do 4) ── */
router.post("/:id/nudge", nudgeLearnerValidation(), nudgeLearner);

/* ── PATCH /api/org-admin/learners/:learnerId/teacher (Final Addendum §4) ── */
router.patch(
  "/:learnerId/teacher",
  assignTeacherToLearnerValidation(),
  assignTeacherToLearner,
);

export default router;
