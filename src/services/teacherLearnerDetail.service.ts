/**
 * Teacher learner detail — Final Addendum §9, Todo 22.4.
 *
 *   GET /api/teacher/learners/:id
 *
 * Returns the same base shape as the org-admin learner detail
 * (`learnerDetail.service.ts`) PLUS the teacher-specific
 * additions the brief lists:
 *
 *   - recent_sessions       — last 5 AISessions with turn-level detail
 *   - vocab_summary         — retained vs in-progress counts
 *   - stage3_objectives     — annotated with per-objective progress
 *   - teacher_reviews       — THIS teacher's reviews only, chronological
 *   - priority_recommendation — current recommended action + timestamp
 *   - safeguarding_alert_count — count only (no detail)
 *
 * Why a separate service rather than extending getLearnerDetailService
 * ====================================================================
 *
 * The access-control gate is fundamentally different. The org-admin
 * endpoint scopes by `learner.orgId === callerOrgId`; this endpoint
 * scopes by `learner.assigned_teacher_id === caller_id`. A shared
 * "gate plus shape" function would have to fork inside, which buries
 * the security invariant in business logic. Two parallel services
 * with the gate up-front each makes the rule auditable at one glance.
 *
 * Some shape duplication is the cost. Worth it for the clarity of
 * the security boundary; a future refactor can extract a shared
 * `buildBaseLearnerProjection` helper without changing either gate.
 *
 * Privacy invariants
 * ==================
 *
 *   1. `teacher_reviews` is filtered to THIS teacher's rows only.
 *      A teacher who shares a learner with another teacher (post-
 *      Phase 21 multi-teacher orgs) cannot see the other teacher's
 *      notes here. The org-admin endpoint shows the full history;
 *      the teacher endpoint shows only their own.
 *   2. Safeguarding is COUNT only. Detail is gated behind the
 *      designated-safeguarding-lead role (Amber admin). Teachers
 *      get awareness ("this learner has an open alert") without
 *      access to the alert text.
 *   3. Recent sessions carry turn text. The brief permits this —
 *      a teacher needs the per-turn detail to write a meaningful
 *      review. Safeguarding-flagged turns ARE included for the
 *      teacher (unlike the evidence-report renderer which filters
 *      them out) because the teacher is the person who needs to
 *      see them most.
 */

import { Types } from "mongoose";
import ApiError from "../errors/apiError";
import ApiResponse from "../errors/apiResponse";
import User from "../models/User";
import AISession from "../models/AISession";
import VocabLedger from "../models/VocabLedger";
import LevelChange from "../models/LevelChange";
import TeacherReview from "../models/TeacherReview";
import Stage5Review from "../models/Stage5Review";
import SafeguardingAlert from "../models/SafeguardingAlert";

// ─────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────

const RECENT_SESSIONS_LIMIT = 5;
/**
 * Per recent session, return up to this many turns. The teacher's
 * dashboard collapses long sessions to a "view full session" link;
 * 20 turns is generous for the inline preview without making the
 * response unwieldy.
 */
const TURNS_PER_RECENT_SESSION = 20;

// ─────────────────────────────────────────────────────────────────────
// Public shapes
// ─────────────────────────────────────────────────────────────────────

interface VocabRow {
  word: string;
  retained: boolean;
  times_encountered: number;
  stage3_objective_id: string | null;
  last_seen_at: string | null;
}

interface RecentSessionTurn {
  role: "learner" | "tutor";
  text: string;
}

interface RecentSession {
  _id: string;
  scenario_id: string | null;
  session_source: string;
  duration_mins: number | null;
  passed: boolean | null;
  esol_level: string | null;
  completed_at: string | null;
  created_at: string;
  stage3_objective_ids: string[];
  turns: RecentSessionTurn[];
  turn_count: number;
  truncated: boolean;
}

interface AnnotatedStage3Objective {
  id: string;
  skill_domain: string;
  description: string;
  target_level: string | null;
  set_from: string | null;
  set_at: string | null;
  progress: {
    vocab_total: number;
    vocab_retained: number;
    vocab_retention_pct: number;
    sessions_touching: number;
  };
}

export interface TeacherLearnerDetailResponse {
  learner: {
    _id: string;
    firstname: string;
    lastname: string;
    email: string | null;
    l1_language: string | null;
    uln: string | null;
    esol_level: string | null;
    starting_level: string | null;
    cohort_status: string | null;
    last_session_at: string | null;
    assigned_teacher_id: string;
    org_id: string;
    org_name: string;
  };
  recent_sessions: RecentSession[];
  vocab_summary: {
    retained: number;
    in_progress: number;
    total: number;
    retention_pct: number;
  };
  stage3_objectives: AnnotatedStage3Objective[];
  teacher_reviews: Array<{
    _id: string;
    review_type: string;
    duration_mins: number;
    notes: string;
    ai_recommendation_acted_on: boolean;
    created_at: string;
  }>;
  priority_recommendation: {
    teacher_priority_level: "p1" | "p2" | "p3" | "p4";
    teacher_recommended_action: string | null;
    /**
     * Todo 23.5 — stable trigger key. The teacher UI dispatches
     * the right click handler off this value rather than parsing
     * the localised template text.
     */
    teacher_priority_trigger_key: string | null;
    recommended_at: string | null;
  };
  safeguarding_alert_count: number;
  /**
   * Final Addendum §9, Todo 22.7 — id of the oldest Stage5Review
   * for this learner that is awaiting the teacher's sign-off
   * (i.e. `teacher_signed_off_at === null`). Null when there's
   * nothing pending. The frontend uses this to gate the "Sign off
   * RARPA Stage 5" CTA; the sign-off endpoint re-validates the
   * cross-reference so a stale value can't accidentally land on
   * the wrong learner.
   */
  pending_stage5_review_id: string | null;
}

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

/**
 * Turn-shape extractor — collapses an AISession.turns[] row to the
 * `{role, text}` pairs the dashboard renders. Each turn carries
 * the learner input + the AI response; we emit them as two
 * sequential rows so a screen-reader reads the conversation
 * naturally.
 */
const flattenTurns = (
  turns: Array<{ originalInput?: string; deepSeekResponse?: string }>,
): RecentSessionTurn[] => {
  const out: RecentSessionTurn[] = [];
  for (const t of turns) {
    if (typeof t.originalInput === "string" && t.originalInput.length > 0) {
      out.push({ role: "learner", text: t.originalInput });
    }
    if (
      typeof t.deepSeekResponse === "string" &&
      t.deepSeekResponse.length > 0
    ) {
      out.push({ role: "tutor", text: t.deepSeekResponse });
    }
  }
  return out;
};

const toIso = (d: Date | null | undefined): string | null =>
  d ? d.toISOString() : null;

// ─────────────────────────────────────────────────────────────────────
// Top-level entry
// ─────────────────────────────────────────────────────────────────────

export const getTeacherLearnerDetailService = async (
  learner_id: string,
  teacher_id: string,
): Promise<ApiResponse> => {
  // ── Input validation ────────────────────────────────────────────
  if (!learner_id || !Types.ObjectId.isValid(learner_id)) {
    throw new ApiError(400, "learner id must be a valid ObjectId");
  }
  if (!teacher_id || !Types.ObjectId.isValid(teacher_id)) {
    throw new ApiError(400, "Authenticated teacher id required");
  }

  const learnerObjectId = new Types.ObjectId(learner_id);
  const teacherObjectId = new Types.ObjectId(teacher_id);

  // ── 1. THE access control gate ─────────────────────────────────
  // Load with a narrow projection just to check assignment, then
  // load fully if the gate passes. 404 vs 403 disambiguation:
  // 404 only when the learner truly doesn't exist; 403 when it
  // exists but isn't assigned to the calling teacher (otherwise
  // we'd leak the existence of every learner ULN via crafted GETs).
  const assignmentCheck = await User.findById(learnerObjectId)
    .select("_id assigned_teacher_id role")
    .lean();
  if (!assignmentCheck) {
    throw new ApiError(404, "Learner not found");
  }
  if (assignmentCheck.role !== "student") {
    throw new ApiError(404, "Learner not found");
  }
  const assignedTo = (
    assignmentCheck as { assigned_teacher_id?: Types.ObjectId | null }
  ).assigned_teacher_id;
  if (!assignedTo || assignedTo.toString() !== teacher_id) {
    throw new ApiError(403, "Forbidden — this learner is not assigned to you.");
  }

  // ── 2. Fan-out — every read in parallel ───────────────────────
  const [
    learner,
    recentSessionsRaw,
    vocabRows,
    objectiveTouchAgg,
    firstLevelChange,
    teacherReviewsRaw,
    safeguardingCount,
    pendingStage5Review,
  ] = await Promise.all([
    // Full learner doc with the fields the response needs.
    User.findById(learnerObjectId)
      .select(
        "_id firstname lastname email l1Language uln esolLevel starting_level " +
          "cohort_status last_session_at orgId assigned_teacher_id stage3_objectives " +
          "teacher_priority_level teacher_recommended_action teacher_priority_trigger_key teacher_priority_updated_at",
      )
      .populate("orgId", "name")
      .lean(),

    // Recent 5 sessions with the first N turns each. We project
    // turns explicitly so a huge session doesn't slurp the whole
    // turn array into memory — Mongo's projection with `$slice`
    // returns the first TURNS_PER_RECENT_SESSION entries; the
    // truncated flag is derived from the original length.
    AISession.find({ learnerId: learnerObjectId })
      .sort({ createdAt: -1 })
      .limit(RECENT_SESSIONS_LIMIT)
      .select({
        _id: 1,
        scenario_id: 1,
        session_source: 1,
        duration_mins: 1,
        passed: 1,
        esolLevel: 1,
        completedAt: 1,
        createdAt: 1,
        stage3_objective_ids: 1,
        turns: { $slice: TURNS_PER_RECENT_SESSION },
        // Carry a derived total turn count alongside the projected
        // slice so the response can report truncation honestly.
        // Mongo doesn't expose array length cheaply via projection;
        // we re-read the count with a second aggregation below.
      })
      .lean(),

    // Vocab — every row, projected to the fields the summary +
    // per-objective progress need.
    VocabLedger.find({ learnerId: learnerObjectId })
      .select(
        "word retained times_encountered stage3_objective_id last_seen_at",
      )
      .lean(),

    // Per-objective session-touching count. Aggregates over the
    // AISession.stage3_objective_ids array, counting one per
    // session per objective. This gives us "how many sessions
    // touched objective X" without slurping every session into JS.
    AISession.aggregate<{ _id: string; sessions_touching: number }>([
      { $match: { learnerId: learnerObjectId } },
      {
        $project: {
          objective_ids: { $ifNull: ["$stage3_objective_ids", []] },
        },
      },
      { $unwind: "$objective_ids" },
      { $group: { _id: "$objective_ids", sessions_touching: { $sum: 1 } } },
    ]),

    LevelChange.findOne({ learnerId: learnerObjectId })
      .sort({ effectiveDate: 1, createdAt: 1 })
      .select("fromLevel")
      .lean(),

    // **Privacy invariant**: filter to THIS teacher's reviews only.
    // The org-admin endpoint shows every teacher's reviews; the
    // teacher endpoint shows only the caller's history with this
    // learner. Chronological per the brief.
    TeacherReview.find({
      learner_id: learnerObjectId,
      teacher_id: teacherObjectId,
    })
      .sort({ created_at: 1 })
      .select(
        "_id review_type duration_mins notes ai_recommendation_acted_on created_at",
      )
      .lean(),

    SafeguardingAlert.countDocuments({ learnerId: learnerObjectId }),

    // Final Addendum §9, Todo 22.7 — surface a pending Stage 5
    // review (one awaiting this teacher's sign-off) so the page
    // can enable / disable the sign-off CTA without a second
    // round-trip. Project the _id only; the sign-off endpoint
    // re-loads the full row and re-validates the cross-reference.
    Stage5Review.findOne({
      learner_id: learnerObjectId,
      teacher_signed_off_at: null,
    })
      .sort({ createdAt: 1 })
      .select("_id")
      .lean(),
  ]);

  if (!learner) {
    // Race — the learner was deleted between the assignment check
    // and the full read. Treat as 404 from this point.
    throw new ApiError(404, "Learner not found");
  }

  // Recent-sessions turn-count back-fill. We need the TOTAL turns
  // per session to compute the truncated flag; we just projected
  // a $slice so we lost that. One bulk aggregate keeps us at a
  // single round-trip for the count.
  const sessionIds = recentSessionsRaw.map((s) => s._id);
  const turnCounts = await AISession.aggregate<{
    _id: Types.ObjectId;
    n: number;
  }>([
    { $match: { _id: { $in: sessionIds } } },
    {
      $project: {
        n: { $size: { $ifNull: ["$turns", []] } },
      },
    },
  ]);
  const turnCountById = new Map<string, number>(
    turnCounts.map((tc) => [tc._id.toString(), tc.n]),
  );

  // ── 3. Project recent_sessions ────────────────────────────────
  const recent_sessions: RecentSession[] = recentSessionsRaw.map((s) => {
    const sid = (s._id as Types.ObjectId).toString();
    const flattened = flattenTurns(
      (
        s as {
          turns?: Array<{ originalInput?: string; deepSeekResponse?: string }>;
        }
      ).turns ?? [],
    );
    const fullTurnCount = turnCountById.get(sid) ?? flattened.length / 2;
    return {
      _id: sid,
      scenario_id:
        typeof (s as { scenario_id?: unknown }).scenario_id === "string"
          ? (s as { scenario_id: string }).scenario_id
          : null,
      session_source:
        (s as { session_source?: string }).session_source ?? "platform",
      duration_mins:
        (s as { duration_mins?: number | null }).duration_mins ?? null,
      passed: (s as { passed?: boolean | null }).passed ?? null,
      esol_level: (s as { esolLevel?: string | null }).esolLevel ?? null,
      completed_at: toIso(
        (s as { completedAt?: Date | null }).completedAt ?? null,
      ),
      created_at: (s as { createdAt: Date }).createdAt.toISOString(),
      stage3_objective_ids:
        (s as { stage3_objective_ids?: string[] }).stage3_objective_ids ?? [],
      turns: flattened,
      turn_count: fullTurnCount,
      truncated: fullTurnCount > TURNS_PER_RECENT_SESSION,
    };
  });

  // ── 4. Vocab summary (counts) ─────────────────────────────────
  const retainedCount = vocabRows.filter(
    (v) => (v as { retained?: boolean }).retained === true,
  ).length;
  const total_vocab = vocabRows.length;
  const vocab_summary = {
    retained: retainedCount,
    in_progress: total_vocab - retainedCount,
    total: total_vocab,
    retention_pct:
      total_vocab > 0 ? Math.round((retainedCount / total_vocab) * 100) : 0,
  };

  // ── 5. Stage 3 objectives with per-objective progress ────────
  const sessionTouchByObjective = new Map<string, number>();
  for (const row of objectiveTouchAgg) {
    sessionTouchByObjective.set(row._id, row.sessions_touching);
  }
  const objectiveVocab = new Map<string, { total: number; retained: number }>();
  for (const v of vocabRows) {
    const objId = (v as { stage3_objective_id?: string | null })
      .stage3_objective_id;
    if (!objId) continue;
    if (!objectiveVocab.has(objId)) {
      objectiveVocab.set(objId, { total: 0, retained: 0 });
    }
    const slot = objectiveVocab.get(objId)!;
    slot.total += 1;
    if ((v as { retained?: boolean }).retained === true) slot.retained += 1;
  }

  const rawObjectives =
    (
      learner as {
        stage3_objectives?: Array<{
          id: string;
          skill_domain: string;
          description: string;
          target_level?: string | null;
          set_from?: string | null;
          set_at?: Date | null;
        }>;
      }
    ).stage3_objectives ?? [];

  const stage3_objectives: AnnotatedStage3Objective[] = rawObjectives.map(
    (obj) => {
      const v = objectiveVocab.get(obj.id);
      const vocab_total = v?.total ?? 0;
      const vocab_retained = v?.retained ?? 0;
      return {
        id: obj.id,
        skill_domain: obj.skill_domain,
        description: obj.description,
        target_level: obj.target_level ?? null,
        set_from: obj.set_from ?? null,
        set_at: toIso(obj.set_at ?? null),
        progress: {
          vocab_total,
          vocab_retained,
          vocab_retention_pct:
            vocab_total > 0
              ? Math.round((vocab_retained / vocab_total) * 100)
              : 0,
          sessions_touching: sessionTouchByObjective.get(obj.id) ?? 0,
        },
      };
    },
  );

  // ── 6. Compose ────────────────────────────────────────────────
  const populatedOrg = (
    learner as unknown as {
      orgId?: { _id: Types.ObjectId; name?: string } | Types.ObjectId | null;
    }
  ).orgId;
  const orgIdStr =
    populatedOrg && typeof populatedOrg === "object" && "_id" in populatedOrg
      ? (populatedOrg._id as Types.ObjectId).toString()
      : populatedOrg
        ? (populatedOrg as Types.ObjectId).toString()
        : "";
  const orgName =
    populatedOrg && typeof populatedOrg === "object" && "name" in populatedOrg
      ? ((populatedOrg as { name?: string }).name ?? "(unnamed org)")
      : "(unnamed org)";

  const starting_level =
    (firstLevelChange as { fromLevel?: string } | null)?.fromLevel ??
    (learner as { starting_level?: string | null }).starting_level ??
    null;

  const payload: TeacherLearnerDetailResponse = {
    learner: {
      _id: (learner._id as Types.ObjectId).toString(),
      firstname: learner.firstname ?? "",
      lastname: learner.lastname ?? "",
      email: learner.email ?? null,
      l1_language:
        (learner as { l1Language?: string | null }).l1Language ?? null,
      uln: (learner as { uln?: string | null }).uln ?? null,
      esol_level: (learner as { esolLevel?: string | null }).esolLevel ?? null,
      starting_level,
      cohort_status:
        (learner as { cohort_status?: string | null }).cohort_status ?? null,
      last_session_at: toIso(
        (learner as { last_session_at?: Date | null }).last_session_at ?? null,
      ),
      assigned_teacher_id: teacher_id,
      org_id: orgIdStr,
      org_name: orgName,
    },
    recent_sessions,
    vocab_summary,
    stage3_objectives,
    teacher_reviews: teacherReviewsRaw.map((r) => ({
      _id: (r._id as Types.ObjectId).toString(),
      review_type: (r as { review_type: string }).review_type,
      duration_mins: (r as { duration_mins: number }).duration_mins,
      notes: (r as { notes?: string }).notes ?? "",
      ai_recommendation_acted_on: Boolean(
        (r as { ai_recommendation_acted_on?: boolean })
          .ai_recommendation_acted_on,
      ),
      created_at: (r as { created_at: Date }).created_at.toISOString(),
    })),
    priority_recommendation: {
      teacher_priority_level:
        (learner as { teacher_priority_level?: "p1" | "p2" | "p3" | "p4" })
          .teacher_priority_level ?? "p4",
      teacher_recommended_action:
        (learner as { teacher_recommended_action?: string | null })
          .teacher_recommended_action ?? null,
      teacher_priority_trigger_key:
        (learner as { teacher_priority_trigger_key?: string | null })
          .teacher_priority_trigger_key ?? null,
      recommended_at: toIso(
        (learner as { teacher_priority_updated_at?: Date | null })
          .teacher_priority_updated_at ?? null,
      ),
    },
    safeguarding_alert_count: safeguardingCount,
    pending_stage5_review_id: pendingStage5Review
      ? (pendingStage5Review._id as Types.ObjectId).toString()
      : null,
  };

  return new ApiResponse(200, "Teacher learner detail", payload);
};

// Re-export internals for tests
export const __internals__ = {
  flattenTurns,
  RECENT_SESSIONS_LIMIT,
  TURNS_PER_RECENT_SESSION,
};
