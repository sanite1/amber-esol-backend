/**
 * Org-admin onboarding embed routes — Phase 2 / Final Addendum §13
 * (BE-G).
 *
 * Mounted at /api/org-admin/onboarding.
 *
 *   GET   /status     — current onboarding state for this org
 *   POST  /complete   — idempotent flag flip + single-shot audit row
 *
 * Auth chain mirrors every other org-admin family route:
 *   isAuthenticated     → JWT valid + account active
 *   isOrgAdmin          → role org_admin (or amber admin)
 *   requireOrgContext   → req.user.orgId is set; the middleware
 *                         attaches it to req.esol_context.org_id
 *                         (Amber admins with no orgId are rejected).
 */

import { Router } from "express";
import { isAuthenticated, isOrgAdmin } from "../middlewares/authMiddleWare";
import { requireOrgContext } from "../middlewares/orgScopingMiddleware";
import {
  getOrgOnboardingStatus,
  markOrgOnboardingComplete,
} from "../controllers/orgOnboarding.controller";
import { markOrgOnboardingCompleteValidation } from "../validations/orgOnboarding.validation";

const router = Router();

router.use(isAuthenticated, isOrgAdmin, requireOrgContext);

router.get("/status", getOrgOnboardingStatus);
router.post(
  "/complete",
  markOrgOnboardingCompleteValidation(),
  markOrgOnboardingComplete,
);

export default router;
