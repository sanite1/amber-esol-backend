/**
 * Stage 5 routes — brief Function 17.
 *
 * Mounted at /api/esol/stage5.
 *
 * Auth chain:
 *   isAuthenticated    → JWT valid + account active
 *   requireOrgContext  → req.user.orgId set, attached to req.esol_context.org_id
 *
 * `requireOrgContext` is the standard gate for /api/esol routes. A
 * learner with no org context is filtered out here; the service-layer
 * "learner_id == req.user.id" check inside submitStage5SelfAssessment
 * provides the per-review access control.
 *
 * Endpoints:
 *   POST  /:reviewId/self-assessment   submit the learner's Stage 5
 *                                      self-assessment (single shot)
 */

import { Router } from "express";
import { isAuthenticated } from "../middlewares/authMiddleWare";
import { requireOrgContext } from "../middlewares/orgScopingMiddleware";
import { submitStage5SelfAssessmentValidation } from "../validations/stage5SelfAssessment.validation";
import {
  submitStage5SelfAssessment,
  listPendingStage5,
  getStage5Review,
} from "../controllers/stage5SelfAssessment.controller";

const router = Router();

router.use(isAuthenticated, requireOrgContext);

// `pending` MUST be declared before `:reviewId` — otherwise Express
// matches "pending" as a value for the reviewId param.
router.get("/pending", listPendingStage5);
router.get("/:reviewId", getStage5Review);
router.post(
  "/:reviewId/self-assessment",
  submitStage5SelfAssessmentValidation(),
  submitStage5SelfAssessment,
);

export default router;
