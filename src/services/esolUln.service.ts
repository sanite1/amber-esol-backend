import ApiError from "../errors/apiError";
import ApiResponse from "../errors/apiResponse";
import User from "../models/User";
import AuditLog from "../models/AuditLog";
import ComplianceConfigService from "./ComplianceConfigService";
import logger from "../config/logger";

/**
 * POST /api/esol/uln — brief Function 2 To-Do 4.
 *
 * The learner is shown a ULN (Unique Learner Number) prompt during
 * onboarding. They either:
 *   (a) Type in their 10-digit ULN  → uln_status = "confirmed"
 *   (b) Tap "I don't know mine / skip" → uln_status = "pending"
 *
 * Critically, (b) is NON-BLOCKING. Many ESOL learners (refugees,
 * asylum seekers, anyone with no prior UK education record) genuinely
 * don't have a ULN at registration time. Blocking them from the AI
 * tutor at this gate would defeat the whole "low-friction onboarding"
 * principle in the brief.
 *
 * Downstream:
 *   - The ILR export job filters or flags learners with uln_status
 *     != "confirmed" so the org admin can chase before the submission
 *     window closes.
 *   - The org admin's "missing ULN" dashboard surfaces these rows.
 *
 * Idempotent: re-submission updates the value (e.g., learner skipped,
 * then later returned with their ULN). Each call is audit-logged so
 * the trail captures the progression.
 *
 * Persistence note: the User schema field is `ulnStatus` (camelCase,
 * pre-Project-Silk). The brief writes it `uln_status` — same value,
 * different name. The API response uses the brief's snake_case.
 */
export const declareUlnService = async (
  userId: string,
  body: { uln?: string; skip: boolean }
) => {
  const user = await User.findById(userId);
  if (!user) {
    throw new ApiError(404, "User not found");
  }
  if (user.role !== "student") {
    throw new ApiError(403, "Only ESOL learners can record a ULN");
  }

  // Capture prior state for the AuditLog before mutating.
  const beforeState = {
    uln: user.uln ?? null,
    uln_status: user.ulnStatus ?? null,
  };

  let reason: string;
  if (body.skip) {
    // Skip path — learner doesn't know their ULN or doesn't have one
    // yet. Status moves to "pending" so the ILR export flags it.
    user.uln = null;
    user.ulnStatus = "pending";
    reason = "Learner skipped ULN entry — will be chased before ILR submission";
  } else {
    // Confirm path — validation already enforced /^\d{10}$/.
    // We re-trim defensively in case middleware was bypassed.
    const trimmed = body.uln!.trim();
    if (!/^\d{10}$/.test(trimmed)) {
      throw new ApiError(400, "uln must be exactly 10 digits");
    }
    user.uln = trimmed;
    user.ulnStatus = "confirmed";
    reason = "Learner confirmed their ULN";
  }

  await user.save();

  const afterState = {
    uln: user.uln ?? null,
    uln_status: user.ulnStatus ?? null,
  };

  // AuditLog — fire-and-forget. A missing audit row is recoverable.
  const ilrConfig = ComplianceConfigService.getCurrent("ilr");
  AuditLog.create({
    timestamp: new Date(),
    actor_type: "learner",
    actor_id: user._id,
    org_id: user.orgId,
    learner_id: user._id,
    action: "uln_recorded",
    before_state: beforeState,
    after_state: afterState,
    reason,
    compliance_config_version: ilrConfig?.version ?? null,
  }).catch((err) =>
    logger.error(
      { err, learnerId: user._id, orgId: user.orgId },
      "AuditLog write failed for uln_recorded"
    )
  );

  return new ApiResponse(200, "ULN recorded", {
    uln_status: user.ulnStatus ?? null,
  });
};
