/**
 * Build a `MISRecord` from the platform's Mongo state — Phase 21,
 * Final Addendum §7.
 *
 * Reads:
 *   - User       — identity, ULN, esolLevel, GLH totals, starting level
 *   - AISession  — for the activity / outcome derivation
 *   - LevelChange — for outcome + completion status when the learner
 *                   has advanced or signed off
 *   - TeacherReview — for `total_glh` contribution (teacher-contact hours)
 *
 * The resulting `MISRecord` is the canonical platform-side shape;
 * the per-vendor adapter then transforms wire field names from it
 * (see `ProSolutionAdapter.toProSolutionPayload` etc).
 *
 * The data assembly here intentionally mirrors what the ILR export
 * pipeline (Function 13 — `ilrExport.service.ts`) computes. If
 * those rules drift, the ILR export will be inconsistent with the
 * MIS push. Phase 22+ could extract a shared `buildLearnerRow`
 * function; for MVP they are parallel implementations with a
 * common rule reference in `ComplianceConfig`.
 */

import { Types } from "mongoose";
import ApiError from "../../errors/apiError";
import User from "../../models/User";
import AISession from "../../models/AISession";
import LevelChange from "../../models/LevelChange";
import TeacherReview from "../../models/TeacherReview";
import logger from "../../config/logger";
import type { MISRecord } from "./types";

// ─────────────────────────────────────────────────────────────────────
// Internal projections — keep Mongo reads narrow
// ─────────────────────────────────────────────────────────────────────

const USER_SELECT = [
  "_id",
  "firstname",
  "lastname",
  "dateOfBirth",
  "uln",
  "orgId",
  "esolLevel",
  "starting_level",
  "esolOnboardedAt",
  "glh_teacher_contact",
  "skillWeaknessFlags",
].join(" ");

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

const toIsoDate = (d: Date | null | undefined): string | null => {
  if (!d) return null;
  return d.toISOString().slice(0, 10);
};

/**
 * Sum AI-session duration_mins for the learner, convert to hours.
 * Used as the AI portion of `total_glh`; teacher hours are added
 * from the User doc's `glh_teacher_contact` running total.
 */
const aiHoursForLearner = async (
  learnerId: Types.ObjectId,
): Promise<number> => {
  const sessions = await AISession.find({ learnerId })
    .select("duration_mins")
    .lean();
  const totalMins = sessions.reduce<number>(
    (acc, s) => acc + ((s as { duration_mins?: number | null }).duration_mins ?? 0),
    0,
  );
  return Math.round((totalMins / 60) * 10) / 10;
};

/**
 * Derive outcome + completion status from LevelChange history. Falls
 * back to ComplianceConfig defaults (held as numeric codes the
 * service consumes downstream) when no level change has occurred.
 *
 * TODO(Phase 21 first customer): confirm the outcome / comp_status
 * code mappings with Joey + the compliance reviewer. The numbers
 * below are placeholders matching common 2025/26 ESFA usage; the
 * validator in `validateMisRecord.ts` re-checks against
 * ComplianceConfig's valid-value lists so a wrong placeholder
 * surfaces as a held record rather than a silent push.
 */
const deriveOutcomeAndCompStatus = async (
  learnerId: Types.ObjectId,
): Promise<{ outcome: number; comp_status: number; learn_act_end_date: string | null }> => {
  const lastConfirmed = await LevelChange.findOne({
    learnerId,
  })
    .sort({ effectiveDate: -1 })
    .select("effectiveDate toLevel")
    .lean();

  if (!lastConfirmed) {
    // No level change yet — still in progress. Brief default
    // codes; revalidated against ComplianceConfig downstream.
    return {
      outcome: 8, // "continuing" placeholder — TODO confirm
      comp_status: 1, // "in learning" — TODO confirm
      learn_act_end_date: null,
    };
  }

  return {
    outcome: 1, // "achieved" placeholder — TODO confirm
    comp_status: 2, // "completed" — TODO confirm
    learn_act_end_date: toIsoDate(
      (lastConfirmed as { effectiveDate?: Date }).effectiveDate ?? null,
    ),
  };
};

// ─────────────────────────────────────────────────────────────────────
// Top-level entry — buildMisRecord
// ─────────────────────────────────────────────────────────────────────

/**
 * Build the canonical `MISRecord` for one ULN under an org.
 *
 * - Throws `ApiError(400)` for invalid `org_id`.
 * - Throws `ApiError(404)` if the learner doesn't exist, doesn't
 *   match the org, or has no ULN.
 *
 * The returned record is unvalidated — the caller passes it
 * through `validateMisRecord` before handing to an adapter.
 */
export const buildMisRecord = async (
  org_id: string,
  uln: string,
): Promise<MISRecord> => {
  if (!org_id || !Types.ObjectId.isValid(org_id)) {
    throw new ApiError(400, "org_id must be a valid ObjectId");
  }
  if (!uln) {
    throw new ApiError(400, "uln is required");
  }

  // Org-scoped lookup — we deliberately project `orgId` and check
  // explicitly rather than `findOne({ orgId, uln })` so the 404
  // message can distinguish "not in this org" from "doesn't exist".
  const learner = await User.findOne({ uln, role: "student" })
    .select(USER_SELECT)
    .lean();
  if (!learner) {
    throw new ApiError(404, `No learner found with ULN ${uln}`);
  }
  if (
    !learner.orgId ||
    learner.orgId.toString() !== org_id
  ) {
    throw new ApiError(
      404,
      `Learner with ULN ${uln} is not in organisation ${org_id}`,
    );
  }

  // ── GLH totals: AI hours + imported (already in totals) + teacher
  // contact hours from the User doc's running total. Teacher contact
  // accumulation lives on the User; per-review duration is on
  // TeacherReview.duration_mins (only used here as a sanity-check
  // log line — we trust the User running total as the authority).
  const aiHours = await aiHoursForLearner(learner._id as Types.ObjectId);
  const teacherContactHours =
    (learner as { glh_teacher_contact?: number }).glh_teacher_contact ?? 0;
  const total_glh = Math.round((aiHours + teacherContactHours) * 10) / 10;

  // Sanity-check log: reviewed-vs-recorded teacher hours. Doesn't
  // change the record; surfaces drift in the logs.
  const reviewedMins = await TeacherReview.aggregate<{
    _id: null;
    total: number;
  }>([
    { $match: { learner_id: learner._id } },
    { $group: { _id: null, total: { $sum: "$duration_mins" } } },
  ]);
  const reviewedHours =
    (reviewedMins[0]?.total ?? 0) / 60;
  if (Math.abs(reviewedHours - teacherContactHours) > 0.5) {
    logger.warn(
      {
        uln,
        org_id,
        teacher_running_total_hours: teacherContactHours,
        teacher_reviewed_hours: Math.round(reviewedHours * 10) / 10,
      },
      "buildMisRecord: teacher GLH running total drift detected (>0.5h gap with sum of TeacherReview rows)",
    );
  }

  const { outcome, comp_status, learn_act_end_date } =
    await deriveOutcomeAndCompStatus(learner._id as Types.ObjectId);

  // ── Compose. Field defaults match the ILR exporter's behaviour
  // for absent values — empty string for required text codes,
  // `null` only where the schema permits.
  const record: MISRecord = {
    uln,
    firstname: learner.firstname ?? "",
    lastname: learner.lastname ?? "",
    date_of_birth:
      toIsoDate((learner as { dateOfBirth?: Date }).dateOfBirth ?? null) ??
      "",
    esol_level: (
      (learner as { esolLevel?: string }).esolLevel ?? ""
    ).toLowerCase(),
    learn_start_date:
      toIsoDate(
        (learner as { esolOnboardedAt?: Date }).esolOnboardedAt ?? null,
      ) ?? "",
    // Planned end = onboarded + 12 months (typical ESOL aim length).
    // TODO(Phase 21): confirm with Joey whether per-org planned-end
    // override should live on Organisation.
    learn_plan_end_date: toIsoDate(
      plusMonths(
        (learner as { esolOnboardedAt?: Date }).esolOnboardedAt ?? null,
        12,
      ),
    ) ?? "",
    learn_act_end_date,
    outcome,
    comp_status,
    // SOF + EnglishProgType: read from ComplianceConfig defaults.
    // The validator will surface "code not in valid-value list"
    // if the placeholder fails the active config.
    sof: "105", // TODO confirm — placeholder for ESFA SOF "ESF" / equivalent
    add_hours: 0,
    english_prog_type: "25", // TODO confirm — placeholder for ESOL pathway
    total_glh,
    skill_codes_covered:
      (learner as { skillWeaknessFlags?: string[] }).skillWeaknessFlags ?? [],
    // raw_payload — escape hatch the adapter can override. Empty
    // by default; per-vendor pre-push hooks can populate.
    raw_payload: {},
  };

  return record;
};

// ─────────────────────────────────────────────────────────────────────
// Date helper
// ─────────────────────────────────────────────────────────────────────

const plusMonths = (d: Date | null | undefined, months: number): Date | null => {
  if (!d) return null;
  const out = new Date(d.getTime());
  out.setUTCMonth(out.getUTCMonth() + months);
  return out;
};

// Re-export for tests
export const __internals__ = {
  aiHoursForLearner,
  deriveOutcomeAndCompStatus,
  plusMonths,
  toIsoDate,
};
