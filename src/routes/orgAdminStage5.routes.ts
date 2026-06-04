/**
 * Stage 5 org-admin routes — brief Function 17.
 *
 * Mounted at /api/org-admin/stage5.
 *
 * Auth chain matches the rest of the org-admin family:
 *   isAuthenticated    → JWT valid + account active
 *   isOrgAdmin         → role is org_admin or admin
 *   requireOrgContext  → req.user.orgId set, attached to req.esol_context.org_id
 *
 * Endpoints:
 *   POST  /:reviewId/confirm   org admin signs off the Stage 5 review
 *                              (single shot; learner self-assessment +
 *                              AI tutor summary must both be in place).
 *
 * The learner-side route (/api/esol/stage5/...) is a separate mount
 * — they don't share the org-admin auth chain.
 */

import { Router } from "express";
import { isAuthenticated, isOrgAdmin } from "../middlewares/authMiddleWare";
import { requireOrgContext } from "../middlewares/orgScopingMiddleware";
import { confirmStage5ReviewValidation } from "../validations/stage5Confirm.validation";
import {
  confirmStage5Review,
  getStage5ReviewForOrgAdmin,
} from "../controllers/stage5Confirm.controller";

const router = Router();

router.use(isAuthenticated, isOrgAdmin, requireOrgContext);

router.get("/:reviewId", getStage5ReviewForOrgAdmin);
router.post(
  "/:reviewId/confirm",
  confirmStage5ReviewValidation(),
  confirmStage5Review,
);

export default router;
