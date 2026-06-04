import { Router } from "express";
import { isAuthenticated } from "../middlewares/authMiddleWare";
import { requireEsolLearner } from "../middlewares/orgScopingMiddleware";
import { declareEligibilityValidation } from "../validations/esolEligibility.validation";
import { declareEligibility } from "../controllers/esolEligibility.controller";

/**
 * POST /api/esol/declare-eligibility — brief Function 2 To-Do 3.
 *
 * Middleware chain:
 *   1. isAuthenticated — populates req.user, re-hydrates from DB,
 *      catches the org-drift edge case
 *   2. requireEsolLearner — role must be "student" AND orgId set.
 *      Blocks marketplace students, admins, tutors, and org_admins
 *      from accidentally calling this on someone else's behalf
 *
 * The brief specifies just isAuthenticated; we add requireEsolLearner
 * as defence-in-depth because the endpoint mutates funding_status —
 * a non-ESOL caller should never touch that field.
 */
const router = Router();

router.post(
  "/",
  isAuthenticated,
  requireEsolLearner,
  declareEligibilityValidation(),
  declareEligibility
);

export default router;
