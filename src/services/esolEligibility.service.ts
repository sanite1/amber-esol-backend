import ApiError from "../errors/apiError";
import ApiResponse from "../errors/apiResponse";
import User from "../models/User";
import AuditLog from "../models/AuditLog";
import ComplianceConfigService from "./ComplianceConfigService";
import logger from "../config/logger";

/**
 * POST /api/esol/declare-eligibility — brief Function 2 To-Do 3.
 *
 * The learner has read and ticked the consent statement:
 *   "I confirm that I am legally entitled to live and study in England.
 *    My organisation has verified my right to access this programme."
 *
 * The platform records THAT the declaration was made and WHEN. The
 * organisation — not the platform — is responsible for verifying Home
 * Office documents, ARC cards, and proof of residency. This separation
 * of duties is documented in DPIA 1 (right-to-study verification).
 *
 * Effect:
 *   - Sets `esol_eligibility_declared_at = now` on the learner.
 *   - Promotes `funding_status` from null/manual_review → "fundable"
 *     IF the postcode lookup at registration time produced a SOF code.
 *     If `sof_code` is null (postcode wasn't in the DfE dataset), we
 *     leave funding_status at "manual_review" so the org admin can
 *     chase the routing before the next ILR submission.
 *
 * Idempotent: a learner who clicks the consent twice (network retry,
 * page reload, etc.) just refreshes the timestamp. Each call is still
 * audit-logged so the trail captures re-confirmation events.
 */
export const declareEligibilityService = async (userId: string) => {
  const user = await User.findById(userId);
  if (!user) {
    throw new ApiError(404, "User not found");
  }
  if (user.role !== "student") {
    throw new ApiError(403, "Only ESOL learners can declare eligibility");
  }

  // Capture the prior state for the AuditLog before mutating.
  // Note: User schema field is `fundingStatus` (camelCase, legacy
  // pre-Project-Silk). The brief writes it as `funding_status` —
  // these refer to the same value; the API response uses the brief's
  // snake_case name.
  const beforeState = {
    esol_eligibility_declared_at:
      user.esol_eligibility_declared_at?.toISOString() ?? null,
    funding_status: user.fundingStatus ?? null,
  };

  user.esol_eligibility_declared_at = new Date();

  // Funding status promotion: ONLY if the postcode lookup at register
  // time produced a real SOF code. If sof_code is null we leave funding
  // at manual_review — the org admin needs to fix the routing before
  // any ILR claim against this learner is submitted.
  if (user.sof_code) {
    user.fundingStatus = "fundable";
  }

  await user.save();

  const afterState = {
    esol_eligibility_declared_at:
      user.esol_eligibility_declared_at!.toISOString(),
    funding_status: user.fundingStatus ?? null,
  };

  // AuditLog — fire-and-forget. A missing audit row is recoverable; a
  // failed declaration would re-prompt the learner unnecessarily.
  const ilrConfig = ComplianceConfigService.getCurrent("ilr");
  AuditLog.create({
    timestamp: new Date(),
    actor_type: "learner",
    actor_id: user._id,
    org_id: user.orgId,
    learner_id: user._id,
    action: "eligibility_declared",
    before_state: beforeState,
    after_state: afterState,
    reason: "Learner confirmed eligibility declaration",
    compliance_config_version: ilrConfig?.version ?? null,
  }).catch((err) =>
    logger.error(
      { err, learnerId: user._id, orgId: user.orgId },
      "AuditLog write failed for eligibility_declared"
    )
  );

  return new ApiResponse(200, "Eligibility declared", {
    status: "declared",
    funding_status: user.fundingStatus ?? null,
  });
};
