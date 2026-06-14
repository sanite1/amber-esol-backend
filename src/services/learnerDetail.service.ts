/**
 * Org-admin learner detail service — brief Function 12 To-Do 2.
 *
 * Backs GET /api/org-admin/learners/:id — the deep-link page the org
 * admin lands on from the cohort table. Composes the same row that
 * appears in the cohort grid PLUS several full-fidelity sub-resources:
 *
 *   - stage3_objectives  : full array from User
 *   - vocab_ledger       : { retained[], in_progress[] }, same shape as
 *                          /api/esol/learners/:id/vocab-ledger
 *   - sessions           : paginated AISession records, recent first,
 *                          heavy fields projected out
 *   - level_progression  : LevelChange records, chronological
 *   - safeguarding_alert_count : just an integer (org admin must not
 *                          see alert details — those belong to the
 *                          Amber DSL per Function 10)
 *   - teacher_reviews    : TeacherReview records, chronological
 *   - audit_log_entries  : paginated AuditLog rows, most recent first
 *
 * Security: the ACL gate is `assertLearnerAccess` (exported from
 * esolLearner.service.ts so this service shares the same primitive).
 * If the caller is an org_admin and `learner.orgId !== callerOrgId`,
 * the helper returns 403 — explicitly distinguished from 404 so the
 * UI shows the right error, but the response shape is identical so a
 * probing caller can't tell which condition fired.
 *
 * The brief calls this "the most important access control in the
 * platform" — every read below is gated on the assertion succeeding.
 * If it throws, NONE of the parallel reads run.
 */

import { Types } from "mongoose";
import ApiError from "../errors/apiError";
import ApiResponse from "../errors/apiResponse";
import User from "../models/User";
import AISession from "../models/AISession";
import VocabLedger from "../models/VocabLedger";
import LevelChange from "../models/LevelChange";
import SafeguardingAlert from "../models/SafeguardingAlert";
import TeacherReview from "../models/TeacherReview";
import AuditLog from "../models/AuditLog";
import { assertLearnerAccess } from "./esolLearner.service";

// ─────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────

const SESSION_DEFAULT_LIMIT = 20;
const SESSION_MAX_LIMIT = 100;
const AUDIT_DEFAULT_LIMIT = 50;
const AUDIT_MAX_LIMIT = 200;

/**
 * Cohort-status collapse — mirrors the cohort table's 5→3 band map
 * (active/inactive/dormant). Duplicated here rather than imported so a
 * detail-page schema rename never has to wait on the cohort-table
 * service. The two files have to agree on the encoding, and the test
 * suite asserts they do.
 */
const COHORT_TO_TABLE_STATUS: Record<
  string,
  "active" | "inactive" | "dormant"
> = {
  active: "active",
  new: "active",
  inactive_mild: "inactive",
  inactive_moderate: "inactive",
  dormant: "dormant",
};

/** Live-status thresholds when cohort_status is null — aligned with
 *  Function 12 To-Do 4 cron bands. */
const LIVE_ACTIVE_MAX_DAYS = 4;
const LIVE_INACTIVE_MAX_DAYS = 14;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ─────────────────────────────────────────────────────────────────────
// Query shape
// ─────────────────────────────────────────────────────────────────────

export interface LearnerDetailQuery {
  sessions_page?: string;
  sessions_limit?: string;
  audit_page?: string;
  audit_limit?: string;
}

// ─────────────────────────────────────────────────────────────────────
// Helpers — single-learner derived fields (one-off equivalents of the
// cohort table aggregation, kept here to avoid a join when we already
// have the User doc in hand)
// ─────────────────────────────────────────────────────────────────────

/**
 * Compute the same per-learner aggregates the cohort table derives in
 * its $lookup sub-pipeline. One Mongo round-trip via aggregate().
 */
const computeSessionAggregates = async (
  learnerId: Types.ObjectId,
): Promise<{
  total_ai_mins: number;
  imported_mins: number;
  scenarios_passed: number;
  last_active: Date | null;
}> => {
  const [agg] = await AISession.aggregate([
    { $match: { learnerId } },
    {
      $group: {
        _id: null,
        total_ai_mins: {
          $sum: {
            $cond: [
              {
                $in: ["$session_source", ["ai_tutor", "teacher_consolidation"]],
              },
              { $ifNull: ["$duration_mins", 0] },
              0,
            ],
          },
        },
        imported_mins: {
          $sum: {
            $cond: [
              { $eq: ["$session_source", "pre_platform"] },
              { $ifNull: ["$duration_mins", 0] },
              0,
            ],
          },
        },
        scenarios_passed: {
          $sum: { $cond: [{ $eq: ["$passed", true] }, 1, 0] },
        },
        last_active: { $max: "$createdAt" },
      },
    },
  ]);

  return {
    total_ai_mins: agg?.total_ai_mins ?? 0,
    imported_mins: agg?.imported_mins ?? 0,
    scenarios_passed: agg?.scenarios_passed ?? 0,
    last_active: (agg?.last_active as Date | undefined) ?? null,
  };
};

const decideLiveStatus = (
  lastActive: Date | null,
): "active" | "inactive" | "dormant" | "unknown" => {
  if (!lastActive) return "unknown";
  const days = (Date.now() - lastActive.getTime()) / MS_PER_DAY;
  if (days <= LIVE_ACTIVE_MAX_DAYS) return "active";
  if (days <= LIVE_INACTIVE_MAX_DAYS) return "inactive";
  return "dormant";
};

const roundHour = (mins: number): number => Math.round((mins / 60) * 10) / 10;

// ─────────────────────────────────────────────────────────────────────
// The service
// ─────────────────────────────────────────────────────────────────────

export const getLearnerDetailService = async (
  learnerId: string,
  callerRole: string,
  callerOrgId: string | null | undefined,
  query: LearnerDetailQuery = {},
): Promise<ApiResponse> => {
  // ── 1. THE access control gate. Nothing else runs until this
  //       succeeds. 404 vs 403 disambiguation handled by helper.
  const { learnerObjectId } = await assertLearnerAccess(
    learnerId,
    callerRole,
    callerOrgId,
  );

  // ── 2. Pagination inputs ──────────────────────────────────────────
  const sessionsPage = Math.max(
    1,
    Math.floor(parseInt(query.sessions_page ?? "1", 10) || 1),
  );
  const sessionsLimit = Math.max(
    1,
    Math.min(
      SESSION_MAX_LIMIT,
      Math.floor(
        parseInt(query.sessions_limit ?? String(SESSION_DEFAULT_LIMIT), 10) ||
          SESSION_DEFAULT_LIMIT,
      ),
    ),
  );
  const auditPage = Math.max(
    1,
    Math.floor(parseInt(query.audit_page ?? "1", 10) || 1),
  );
  const auditLimit = Math.max(
    1,
    Math.min(
      AUDIT_MAX_LIMIT,
      Math.floor(
        parseInt(query.audit_limit ?? String(AUDIT_DEFAULT_LIMIT), 10) ||
          AUDIT_DEFAULT_LIMIT,
      ),
    ),
  );

  // ── 3. Fan-out — all reads in parallel ────────────────────────────
  // The User read is duplicated against the one inside assertLearnerAccess
  // because we need full projection here. Worth it: the alternative
  // (pass the User through) would couple the two services in a way
  // that makes the ACL helper harder to reuse for the lighter
  // /vocab-ledger and /sessions endpoints.
  const [
    learner,
    sessionAgg,
    firstLevelChange,
    assignedTeacherDoc,
    vocabRows,
    sessions,
    sessionsTotal,
    levelProgression,
    safeguardingAlertCount,
    teacherReviews,
    auditEntries,
    auditTotal,
  ] = await Promise.all([
    User.findById(learnerObjectId)
      .select(
        "_id firstname lastname email l1Language esolLevel starting_level " +
          "esol_aim_type uln cohort_status stage3_objectives glh_teacher_contact " +
          "assigned_teacher_id last_session_at progression_notification_sent_at " +
          "progression_notification_level skillWeaknessFlags createdAt",
      )
      .lean(),
    computeSessionAggregates(learnerObjectId),
    LevelChange.findOne({ learnerId: learnerObjectId })
      .sort({ effectiveDate: 1, createdAt: 1 })
      .select("fromLevel")
      .lean(),
    // Teacher name lookup — fired in parallel with everything else;
    // the User doc carrying assigned_teacher_id loads in the same
    // Promise.all bucket, but we don't know the id yet. Do this
    // lookup conditionally below from the resolved learner.
    Promise.resolve(null as { firstname?: string; lastname?: string } | null),
    VocabLedger.find({ learnerId: learnerObjectId })
      .select(
        "word definition_en times_encountered retained scenario_first_seen " +
          "stage3_objective_id last_seen_at introducedAt",
      )
      .lean(),
    AISession.find({ learnerId: learnerObjectId })
      .sort({ createdAt: -1 })
      .skip((sessionsPage - 1) * sessionsLimit)
      .limit(sessionsLimit)
      .select(
        "_id sessionMode esolLevel scenario_id session_source duration_mins " +
          "final_score passed completedAt createdAt start_time end_time",
      )
      .lean(),
    AISession.countDocuments({ learnerId: learnerObjectId }),
    LevelChange.find({ learnerId: learnerObjectId })
      .sort({ effectiveDate: 1, createdAt: 1 })
      .select(
        "_id fromLevel toLevel reason triggerEvent effectiveDate createdAt changedBy",
      )
      .lean(),
    SafeguardingAlert.countDocuments({ learnerId: learnerObjectId }),
    TeacherReview.find({ learner_id: learnerObjectId })
      .sort({ created_at: 1 })
      .select(
        "_id teacher_id review_type duration_mins notes ai_recommendation_acted_on created_at",
      )
      .lean(),
    AuditLog.find({ learner_id: learnerObjectId })
      .sort({ timestamp: -1 })
      .skip((auditPage - 1) * auditLimit)
      .limit(auditLimit)
      .select(
        "_id timestamp actor_type actor_id action before_state after_state reason",
      )
      .lean(),
    AuditLog.countDocuments({ learner_id: learnerObjectId }),
  ]);

  if (!learner) {
    // Should be unreachable — assertLearnerAccess already verified
    // existence. Defensive: a race where the learner was deleted
    // between the assert and the projection would land here.
    throw new ApiError(404, "Learner not found");
  }

  // Now resolve the assigned teacher's display name. Sequential with
  // the rest because we need learner.assigned_teacher_id first; cheap
  // single-doc lookup so the latency hit is negligible.
  let assignedTeacherName: string | null = null;
  if (learner.assigned_teacher_id) {
    const teacherDoc = await User.findById(learner.assigned_teacher_id)
      .select("firstname lastname")
      .lean();
    if (teacherDoc) {
      const name =
        `${teacherDoc.firstname ?? ""} ${teacherDoc.lastname ?? ""}`.trim();
      assignedTeacherName = name.length > 0 ? name : null;
    }
  }
  // Suppress unused-warning — the placeholder slot in Promise.all keeps
  // positional order stable if we ever decide to parallelise this lookup.
  void assignedTeacherDoc;

  // ── 4. Derived row fields (same shape as cohort table) ────────────
  const total_ai_hours = roundHour(sessionAgg.total_ai_mins);
  const imported_hours = roundHour(sessionAgg.imported_mins);
  const teacher_contact_hours = learner.glh_teacher_contact ?? 0;
  const total_glh =
    Math.round((total_ai_hours + imported_hours + teacher_contact_hours) * 10) /
    10;

  const cohortBand = learner.cohort_status as string | null | undefined;
  const status: "active" | "inactive" | "dormant" | "unknown" = cohortBand
    ? (COHORT_TO_TABLE_STATUS[cohortBand] ??
      decideLiveStatus(sessionAgg.last_active))
    : decideLiveStatus(sessionAgg.last_active);

  const starting_level =
    (firstLevelChange as { fromLevel?: string } | null)?.fromLevel ??
    learner.starting_level ??
    null;

  const uln_status: "recorded" | "missing" =
    typeof learner.uln === "string" && learner.uln.trim().length > 0
      ? "recorded"
      : "missing";

  // ── 5. Vocab ledger — same shape as the dedicated endpoint ────────
  const retained = vocabRows
    .filter((r) => (r as { retained?: boolean }).retained === true)
    .sort(
      (a, b) =>
        new Date((a as { introducedAt?: Date }).introducedAt ?? 0).getTime() -
        new Date((b as { introducedAt?: Date }).introducedAt ?? 0).getTime(),
    );
  const in_progress = vocabRows
    .filter((r) => (r as { retained?: boolean }).retained !== true)
    .sort((a, b) => {
      const ax = a as {
        last_seen_at?: Date | null;
        times_encountered?: number;
      };
      const bx = b as {
        last_seen_at?: Date | null;
        times_encountered?: number;
      };
      const at = ax.last_seen_at ? new Date(ax.last_seen_at).getTime() : 0;
      const bt = bx.last_seen_at ? new Date(bx.last_seen_at).getTime() : 0;
      if (at !== bt) return at - bt;
      return (ax.times_encountered ?? 0) - (bx.times_encountered ?? 0);
    });

  // ── 6. Compose the response ───────────────────────────────────────
  return new ApiResponse(200, "Learner detail retrieved", {
    learner: {
      _id: learner._id.toString(),
      firstname: learner.firstname ?? "",
      lastname: learner.lastname ?? "",
      email: learner.email ?? null,
      l1_language: learner.l1Language ?? null,
      esol_level: learner.esolLevel ?? null,
      starting_level,
      esol_aim_type: learner.esol_aim_type ?? null,
      uln_status,
      cohort_status: learner.cohort_status ?? null,
      status,
      total_ai_hours,
      imported_hours,
      teacher_contact_hours,
      total_glh,
      scenarios_passed: sessionAgg.scenarios_passed,
      last_active:
        sessionAgg.last_active instanceof Date
          ? sessionAgg.last_active.toISOString()
          : null,
      assigned_teacher_id: learner.assigned_teacher_id
        ? learner.assigned_teacher_id.toString()
        : null,
      assigned_teacher_name: assignedTeacherName,
      skill_weakness_flags: learner.skillWeaknessFlags ?? [],
      // Progression cron breadcrumbs — useful when triaging "why
      // didn't this learner get re-notified?"
      progression_notification_sent_at:
        learner.progression_notification_sent_at instanceof Date
          ? learner.progression_notification_sent_at.toISOString()
          : null,
      progression_notification_level:
        learner.progression_notification_level ?? null,
    },
    stage3_objectives: learner.stage3_objectives ?? [],
    vocab_ledger: {
      retained,
      in_progress,
      totals: {
        retained: retained.length,
        in_progress: in_progress.length,
        total: vocabRows.length,
      },
    },
    sessions: {
      rows: sessions,
      pagination: {
        page: sessionsPage,
        limit: sessionsLimit,
        total: sessionsTotal,
        total_pages: Math.ceil(sessionsTotal / sessionsLimit) || 1,
      },
    },
    level_progression: levelProgression,
    safeguarding_alert_count: safeguardingAlertCount,
    teacher_reviews: teacherReviews,
    audit_log_entries: {
      rows: auditEntries,
      pagination: {
        page: auditPage,
        limit: auditLimit,
        total: auditTotal,
        total_pages: Math.ceil(auditTotal / auditLimit) || 1,
      },
    },
  });
};

export const __internals__ = {
  decideLiveStatus,
  computeSessionAggregates,
  COHORT_TO_TABLE_STATUS,
  SESSION_DEFAULT_LIMIT,
  SESSION_MAX_LIMIT,
  AUDIT_DEFAULT_LIMIT,
  AUDIT_MAX_LIMIT,
};
