import { Router } from "express";
import { referralTokenLimiter } from "../config/rateLimiter";
import { verifyTokenBodyValidation } from "../validations/esolReferral.validation";
import { verifyReferralToken } from "../controllers/esolReferral.controller";

/**
 * POST /api/esol/verify-token (brief Function 2 To-Do 1)
 *
 * Public — no auth required. This is the very first call a prospective
 * learner makes when clicking a referral link, BEFORE they have an
 * account. The endpoint:
 *
 *   1. Verifies the JWT signature and expiry
 *   2. Checks `type === "esol_referral"` claim
 *   3. Looks up the org + checks billing_active
 *   4. Looks up the ReferralToken row + checks isActive
 *   5. Atomically increments usage_count
 *   6. Returns { org_id, org_name, org_type }
 *
 * The frontend uses the response to render a welcome screen ("Hi, you've
 * been invited by <org_name>") before the registration wizard begins.
 *
 * Rate-limited via `referralTokenLimiter` (20/hour per IP) to prevent
 * token enumeration / org-name harvesting. The previous endpoint at
 * GET /api/esol/referrals/validate/:token uses authLimiter (5/15min);
 * 20/hour is more permissive because Function 2 calls this on every
 * page load of the registration wizard.
 */
const router = Router();

router.post(
  "/",
  referralTokenLimiter,
  verifyTokenBodyValidation(),
  verifyReferralToken,
);

export default router;
