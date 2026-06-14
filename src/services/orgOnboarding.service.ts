/**
 * Org-admin onboarding embed — Phase 2 / Final Addendum §13 (BE-G).
 *
 * Two ops:
 *   getOrgOnboardingStatusService(orgId)        → { completed_at }
 *   markOrgOnboardingCompleteService(orgId, …)  → flips the flag once
 *
 * Why this isn't tied to the ROI submission row
 * =============================================
 *
 * The public ROI calculator (`/api/public/roi-calculator/submit`) is
 * intentionally unauthenticated — anyone can fill it in, and the row
 * lands in `RoiCalculatorSubmission` (a sales-intel collection). We
 * want the onboarding flag to be set when the AUTHENTICATED org_admin
 * completes the calculator OR explicitly skips it. The public
 * endpoint can't know it's an authenticated org_admin without a
 * second round-trip; rather than wedge auth into the public surface,
 * we expose a tiny authenticated companion endpoint here that the
 * frontend calls explicitly on success / skip.
 *
 * Idempotency
 * ===========
 *
 * `markOrgOnboardingCompleteService` is idempotent: it only writes
 * the audit row + flips the field on the FIRST call. Subsequent
 * calls return the existing completed_at without re-stamping or
 * writing a duplicate audit row. This matches the
 * `teacher_message_read` pattern used elsewhere — "flip the flag,
 * but only once."
 *
 * Why a separate field rather than overloading an existing one
 * ============================================================
 *
 * We could have piggy-backed on `Organisation.createdAt` (treat any
 * org that's older than X days as "onboarded") but that conflates
 * two distinct concerns:
 *   1. When did the org start existing? (createdAt)
 *   2. Has the org_admin completed first-login setup? (this field)
 *
 * Future onboarding steps (e.g. "import your first cohort", "invite
 * your first teacher") will chain off this flag — naming it
 * `org_onboarding_completed_at` (not `roi_calculator_completed_at`)
 * keeps that door open.
 */

import { Types } from "mongoose";
import ApiError from "../errors/apiError";
import ApiResponse from "../errors/apiResponse";
import Organisation from "../models/Organisation";
import { writeAuditLog } from "./auditLog.service";

export interface OrgOnboardingStatusPayload {
  /** ISO-8601 timestamp when the org_admin first marked it complete, or null. */
  completed_at: string | null;
}

export interface MarkOrgOnboardingCompleteInput {
  org_id: string;
  actor_user_id: string;
  /**
   * Free-text describing which path tripped the mark. Used in the
   * audit row's `reason` field. Examples: "ROI calculator submitted",
   * "Skipped from onboarding embed".
   */
  source: "roi_calculator_submitted" | "skipped" | string;
}

// ─────────────────────────────────────────────────────────────────────
// GET status
// ─────────────────────────────────────────────────────────────────────

export const getOrgOnboardingStatusService = async (
  orgId: string,
): Promise<ApiResponse> => {
  if (!orgId || !Types.ObjectId.isValid(orgId)) {
    throw new ApiError(400, "Organisation context is required");
  }

  const org = await Organisation.findById(orgId)
    .select("_id org_onboarding_completed_at")
    .lean();

  if (!org) {
    // Either the orgId was tampered with or the org was deleted out
    // from under the org_admin. Either way, an opaque 404 is the
    // right answer — we don't want to leak whether the id was valid
    // but missing vs. invalid format.
    throw new ApiError(404, "Organisation not found");
  }

  const completedAt = (org as { org_onboarding_completed_at?: Date | null })
    .org_onboarding_completed_at;

  const payload: OrgOnboardingStatusPayload = {
    completed_at: completedAt ? completedAt.toISOString() : null,
  };

  return new ApiResponse(200, "Onboarding status retrieved", payload);
};

// ─────────────────────────────────────────────────────────────────────
// POST mark complete — idempotent
// ─────────────────────────────────────────────────────────────────────

export const markOrgOnboardingCompleteService = async (
  input: MarkOrgOnboardingCompleteInput,
): Promise<ApiResponse> => {
  if (!input.org_id || !Types.ObjectId.isValid(input.org_id)) {
    throw new ApiError(400, "Organisation context is required");
  }
  if (!input.actor_user_id || !Types.ObjectId.isValid(input.actor_user_id)) {
    throw new ApiError(400, "Actor user id is required");
  }

  const org = await Organisation.findById(input.org_id)
    .select("_id org_onboarding_completed_at")
    .lean();
  if (!org) {
    throw new ApiError(404, "Organisation not found");
  }

  const existing = (org as { org_onboarding_completed_at?: Date | null })
    .org_onboarding_completed_at;

  // ── Idempotent path: already stamped → return the existing value
  //    without writing a second audit row.
  if (existing) {
    return new ApiResponse(200, "Onboarding already completed", {
      completed_at: existing.toISOString(),
      already_completed: true,
    });
  }

  const now = new Date();
  // Atomic stamp: a concurrent caller hitting the same endpoint at
  // the same time can't write two audit rows because we use a
  // conditional update (only flips when the field is still null).
  // The check above + the conditional below close the race window.
  const updated = await Organisation.findOneAndUpdate(
    {
      _id: new Types.ObjectId(input.org_id),
      $or: [
        { org_onboarding_completed_at: { $exists: false } },
        { org_onboarding_completed_at: null },
      ],
    },
    { $set: { org_onboarding_completed_at: now } },
    { new: true },
  )
    .select("_id org_onboarding_completed_at")
    .lean();

  if (!updated) {
    // The conditional update missed — most likely a concurrent
    // caller stamped it microseconds before us. Re-read so we
    // return the actual landed timestamp rather than a 500.
    const after = await Organisation.findById(input.org_id)
      .select("org_onboarding_completed_at")
      .lean();
    const stamped = (
      after as { org_onboarding_completed_at?: Date | null } | null
    )?.org_onboarding_completed_at;
    return new ApiResponse(200, "Onboarding already completed", {
      completed_at: stamped ? stamped.toISOString() : now.toISOString(),
      already_completed: true,
    });
  }

  // ── First-time write: audit-log row. Single-shot by design;
  //    `existing` was null when we entered the function, so this
  //    only ever fires once per org. Subsequent callers hit the
  //    idempotent branch above before this audit write is reached.
  await writeAuditLog({
    actor_type: "org_admin",
    actor_id: input.actor_user_id,
    org_id: input.org_id,
    learner_id: null,
    action: "org_onboarding_completed",
    before_state: { org_onboarding_completed_at: null },
    after_state: { org_onboarding_completed_at: now },
    reason: `Org-admin onboarding embed completed (source: ${input.source}).`,
  });

  return new ApiResponse(201, "Onboarding marked complete", {
    completed_at: now.toISOString(),
    already_completed: false,
  });
};
