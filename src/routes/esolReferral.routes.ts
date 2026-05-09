import { Router } from "express";
import { isAuthenticated, isOrgAdmin } from "../middlewares/authMiddleWare";
import { authLimiter } from "../config/rateLimiter";
import {
  createReferralValidation,
  listReferralsValidation,
  validateTokenParamValidation,
  registerViaReferralValidation,
} from "../validations/esolReferral.validation";
import {
  createReferralToken,
  listReferralTokens,
  validateReferralToken,
  registerViaReferral,
} from "../controllers/esolReferral.controller";

const router = Router();

// Public: validate a token before registration (no auth required).
// Rate-limited to prevent token enumeration / org-name harvesting.
router.get(
  "/validate/:token",
  authLimiter,
  validateTokenParamValidation(),
  validateReferralToken
);

// Public: register learner via referral token (rate-limited)
router.post(
  "/register",
  authLimiter,
  registerViaReferralValidation(),
  registerViaReferral
);

// Authenticated routes below
router.use(isAuthenticated);

// Create referral token and optionally send invite email (org_admin | admin)
router.post("/", isOrgAdmin, createReferralValidation(), createReferralToken);

// List referral tokens for org (org_admin | admin)
router.get("/", isOrgAdmin, listReferralsValidation(), listReferralTokens);

export default router;
