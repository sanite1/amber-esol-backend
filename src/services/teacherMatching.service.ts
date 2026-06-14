/**
 * Needs-based learner→teacher matching — the assignment foundation.
 *
 * Three surfaces:
 *
 *   rankTeachersForLearner       scored candidate list for ONE learner
 *                                (powers the org-admin "suggested
 *                                teachers" UI + auto-assign)
 *   autoAssignTeacherForLearner  pick + persist the best match for an
 *                                unassigned learner (fired on learner
 *                                registration, and per-learner by the
 *                                bulk endpoint)
 *   autoAssignUnassignedForOrg   org-admin bulk action — walk every
 *                                unassigned learner in the org
 *
 * Matching model (deliberately simple + explainable):
 *
 *   HARD FILTERS — a teacher is eligible only if:
 *     - approved (esolTeacherApproved) AND in org.assigned_teacher_ids
 *       AND User.orgId matches              (same gates as manual flow)
 *     - under max_learners_per_teacher      (never auto-overload)
 *     - teaching_profile.levels_taught is EMPTY (unspecified) or
 *       contains the learner's level        (level coverage)
 *
 *   SCORE (higher = better) — additive, every point traceable to a
 *   human-readable reason string:
 *     +3  speaks the learner's first language
 *     +2  explicitly teaches the learner's level (vs unspecified)
 *     +2  exam_preparation specialism for a `regulated` aim learner
 *     +1  employability specialism for an employed/seeking learner
 *     + (1 - utilisation)  load tie-break in (0,1] — among equal
 *       fits, prefer the least-loaded teacher; can never outweigh a
 *       whole matching signal.
 *
 *   FALLBACK — if no candidate passes the level hard filter, retry
 *   with that filter dropped (an imperfect teacher beats no teacher);
 *   capacity is never dropped. Zero eligible teachers → learner
 *   simply stays unassigned (exactly the pre-matching behaviour).
 *
 * Every auto-assignment writes the same AuditLog entry shape as the
 * manual org-admin flow, with actor_type "system" and the match
 * reasons in `reason` — an inspector can always distinguish machine
 * suggestions from human decisions.
 */

import { Types } from "mongoose";
import ApiError from "../errors/apiError";
import ApiResponse from "../errors/apiResponse";
import Organisation from "../models/Organisation";
import User from "../models/User";
import AuditLog from "../models/AuditLog";
import logger from "../config/logger";

// ─────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────

/** Canonical specialism keys — the FE renders the labels. */
export const TEACHER_SPECIALISMS = [
  "exam_preparation",
  "employability",
  "everyday_english",
  "family_learning",
  "send_support",
  "digital_skills",
] as const;
export type TeacherSpecialism = (typeof TEACHER_SPECIALISMS)[number];

export const TEACHING_LEVEL_CODES = ["e1", "e2", "e3", "l1", "l2"] as const;

const WEIGHT_L1_MATCH = 3;
const WEIGHT_LEVEL_EXPLICIT = 2;
const WEIGHT_EXAM_SPECIALISM = 2;
const WEIGHT_EMPLOYABILITY = 1;

// ─────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────

interface TeachingProfile {
  levels_taught?: string[];
  languages_spoken?: string[];
  specialisms?: string[];
}

/** The learner fields matching reads — pass a lean doc or subset. */
export interface MatchLearner {
  esolLevel?: string | null;
  l1Language?: string | null;
  esol_aim_type?: string | null;
  employment_status?: string | number | null;
}

/** The teacher fields matching reads. */
export interface MatchTeacher {
  _id: Types.ObjectId | string;
  firstname?: string;
  lastname?: string;
  teaching_profile?: TeachingProfile | null;
}

export interface TeacherMatchResult {
  eligible: boolean;
  /** Why ineligible (capacity / level) — null when eligible. */
  ineligible_reason: string | null;
  score: number;
  /** Human-readable signals, e.g. "Speaks Arabic". Shown as chips. */
  reasons: string[];
}

export interface RankedTeacherMatch extends TeacherMatchResult {
  teacher_id: string;
  firstname: string;
  lastname: string;
  assigned_learner_count: number;
  max_learners_per_teacher: number;
  teaching_profile: Required<TeachingProfile>;
}

// ─────────────────────────────────────────────────────────────────────
// Pure scorer — unit-testable, no I/O
// ─────────────────────────────────────────────────────────────────────

/** "Entry 1" / "e1" / "ENTRY1" → "e1"; unknown → null. */
export const levelToCode = (raw: unknown): string | null => {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const lc = raw.trim().toLowerCase();
  if ((TEACHING_LEVEL_CODES as readonly string[]).includes(lc)) return lc;
  const m = lc.match(/^(entry|level)\s*(\d)$/);
  if (m) return `${m[1] === "entry" ? "e" : "l"}${m[2]}`;
  return null;
};

const LEVEL_LABELS: Record<string, string> = {
  e1: "Entry 1",
  e2: "Entry 2",
  e3: "Entry 3",
  l1: "Level 1",
  l2: "Level 2",
};

/**
 * Score one teacher against one learner. `load`/`cap` express the
 * teacher's CURRENT caseload vs the org cap.
 *
 * `enforceLevelFilter=false` is the fallback pass — level coverage
 * stops being a hard gate but an explicit match still scores.
 */
export const scoreTeacherForLearner = (
  learner: MatchLearner,
  teacher: MatchTeacher,
  load: number,
  cap: number,
  enforceLevelFilter = true,
): TeacherMatchResult => {
  const profile = teacher.teaching_profile ?? {};
  const levels = (profile.levels_taught ?? []).map(levelToCode).filter(Boolean);
  const languages = (profile.languages_spoken ?? []).map((l) =>
    String(l).trim().toLowerCase(),
  );
  const specialisms = profile.specialisms ?? [];

  // ── Hard filter: capacity. Never auto-assign past the org cap. ──
  if (cap > 0 && load >= cap) {
    return {
      eligible: false,
      ineligible_reason: "At capacity",
      score: 0,
      reasons: [],
    };
  }

  const learnerLevel = levelToCode(learner.esolLevel);

  // ── Hard filter: level coverage (only when the profile names
  //    levels — an unfilled profile never blocks assignment). ──
  if (
    enforceLevelFilter &&
    learnerLevel &&
    levels.length > 0 &&
    !levels.includes(learnerLevel)
  ) {
    return {
      eligible: false,
      ineligible_reason: `Doesn't teach ${LEVEL_LABELS[learnerLevel] ?? learnerLevel}`,
      score: 0,
      reasons: [],
    };
  }

  let score = 0;
  const reasons: string[] = [];

  if (learnerLevel && levels.includes(learnerLevel)) {
    score += WEIGHT_LEVEL_EXPLICIT;
    reasons.push(`Teaches ${LEVEL_LABELS[learnerLevel] ?? learnerLevel}`);
  }

  const l1 = (learner.l1Language ?? "").trim().toLowerCase();
  if (l1 && languages.includes(l1)) {
    score += WEIGHT_L1_MATCH;
    reasons.push(`Speaks ${learner.l1Language}`);
  }

  if (
    learner.esol_aim_type === "regulated" &&
    specialisms.includes("exam_preparation")
  ) {
    score += WEIGHT_EXAM_SPECIALISM;
    reasons.push("Exam preparation specialist");
  }

  // employment_status follows the ILR coding the onboarding wizard
  // collects; anything present-and-truthy that isn't clearly
  // "not seeking" gets the (small) employability nudge.
  if (
    learner.employment_status != null &&
    String(learner.employment_status).trim() !== "" &&
    specialisms.includes("employability")
  ) {
    score += WEIGHT_EMPLOYABILITY;
    reasons.push("Employability specialist");
  }

  // Load tie-break in (0,1] — strictly smaller than any real signal.
  const utilisation = cap > 0 ? Math.min(load / cap, 1) : 0;
  score += 1 - utilisation;

  return { eligible: true, ineligible_reason: null, score, reasons };
};

// ─────────────────────────────────────────────────────────────────────
// Candidate loader (shared by rank + auto-assign)
// ─────────────────────────────────────────────────────────────────────

interface CandidatePool {
  cap: number;
  teachers: Array<{
    _id: Types.ObjectId;
    firstname: string;
    lastname: string;
    createdAt: Date;
    teaching_profile: Required<TeachingProfile>;
    assigned_learner_count: number;
  }>;
}

const loadCandidatePool = async (orgId: string): Promise<CandidatePool> => {
  if (!orgId || !Types.ObjectId.isValid(orgId)) {
    throw new ApiError(400, "Valid orgId is required");
  }
  const org = await Organisation.findById(orgId)
    .select("assigned_teacher_ids max_learners_per_teacher")
    .lean();
  if (!org) throw new ApiError(404, "Organisation not found");

  const cap = (org.max_learners_per_teacher as number) ?? 0;
  const ids = (org.assigned_teacher_ids ?? []) as Types.ObjectId[];
  if (ids.length === 0) return { cap, teachers: [] };

  const orgObjectId = new Types.ObjectId(orgId);
  const teachers = await User.find({
    _id: { $in: ids },
    orgId: orgObjectId,
    role: "tutor",
    esolTeacherApproved: true,
  })
    .select("firstname lastname teaching_profile createdAt")
    .lean();

  const counts = await User.aggregate<{ _id: Types.ObjectId; count: number }>([
    {
      $match: {
        role: "student",
        orgId: orgObjectId,
        isActive: true,
        assigned_teacher_id: { $in: teachers.map((t) => t._id) },
      },
    },
    { $group: { _id: "$assigned_teacher_id", count: { $sum: 1 } } },
  ]);
  const countByTeacher = new Map(
    counts.map((c) => [c._id.toString(), c.count]),
  );

  return {
    cap,
    teachers: teachers.map((t) => ({
      _id: t._id as Types.ObjectId,
      firstname: t.firstname ?? "",
      lastname: t.lastname ?? "",
      createdAt: (t as { createdAt?: Date }).createdAt ?? new Date(0),
      teaching_profile: {
        levels_taught: t.teaching_profile?.levels_taught ?? [],
        languages_spoken: t.teaching_profile?.languages_spoken ?? [],
        specialisms: t.teaching_profile?.specialisms ?? [],
      },
      assigned_learner_count: countByTeacher.get(t._id.toString()) ?? 0,
    })),
  };
};

const rankPool = (
  pool: CandidatePool,
  learner: MatchLearner,
  enforceLevelFilter: boolean,
): RankedTeacherMatch[] =>
  pool.teachers
    .map((t) => ({
      t,
      match: scoreTeacherForLearner(
        learner,
        t,
        t.assigned_learner_count,
        pool.cap,
        enforceLevelFilter,
      ),
    }))
    .map(({ t, match }) => ({
      teacher_id: t._id.toString(),
      firstname: t.firstname,
      lastname: t.lastname,
      assigned_learner_count: t.assigned_learner_count,
      max_learners_per_teacher: pool.cap,
      teaching_profile: t.teaching_profile,
      ...match,
    }))
    .sort((a, b) => {
      if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
      if (b.score !== a.score) return b.score - a.score;
      // Deterministic tie-breaks: lower load, then name.
      if (a.assigned_learner_count !== b.assigned_learner_count) {
        return a.assigned_learner_count - b.assigned_learner_count;
      }
      return a.lastname.localeCompare(b.lastname);
    });

// ─────────────────────────────────────────────────────────────────────
// rankTeachersForLearner — org-admin "suggested teachers"
// ─────────────────────────────────────────────────────────────────────

export const rankTeachersForLearner = async (
  callerOrgId: string,
  learnerId: string,
): Promise<ApiResponse> => {
  if (!learnerId || !Types.ObjectId.isValid(learnerId)) {
    throw new ApiError(400, "learnerId must be a valid ObjectId");
  }
  const learner = await User.findById(learnerId)
    .select(
      "orgId role esolLevel l1Language esol_aim_type employment_status assigned_teacher_id",
    )
    .lean();
  if (!learner) throw new ApiError(404, "Learner not found");
  if (learner.role !== "student") {
    throw new ApiError(400, "Target user is not a student");
  }
  if (learner.orgId?.toString() !== callerOrgId) {
    throw new ApiError(403, "Learner does not belong to your organisation");
  }

  const pool = await loadCandidatePool(callerOrgId);
  // The ranked list keeps ineligible teachers (with the reason) so
  // the org admin sees WHY someone isn't suggested, not a silent gap.
  const matches = rankPool(pool, learner, true);

  return new ApiResponse(200, "Teacher matches ranked", {
    learner_id: learnerId,
    current_teacher_id: learner.assigned_teacher_id?.toString() ?? null,
    matches,
  });
};

// ─────────────────────────────────────────────────────────────────────
// autoAssignTeacherForLearner
// ─────────────────────────────────────────────────────────────────────

export interface AutoAssignResult {
  assigned: boolean;
  teacher_id: string | null;
  reasons: string[];
  /** Why nothing was assigned (no teachers / all at capacity). */
  skipped_reason: string | null;
}

/**
 * Pick + persist the best-match teacher for an UNASSIGNED learner.
 * No-ops (assigned:false) rather than throws for "soft" outcomes so
 * the registration flow can fire-and-forget it.
 *
 * actor: null → audit rows say actor_type "system" (registration
 * hook); pass the org-admin id for the bulk endpoint so the human
 * trigger is on record.
 */
export const autoAssignTeacherForLearner = async (
  learnerId: string | Types.ObjectId,
  actor: { callerId: string } | null = null,
): Promise<AutoAssignResult> => {
  const learner = await User.findById(learnerId)
    .select(
      "orgId role isActive esolLevel l1Language esol_aim_type employment_status assigned_teacher_id",
    )
    .lean();
  if (!learner || learner.role !== "student" || !learner.orgId) {
    return {
      assigned: false,
      teacher_id: null,
      reasons: [],
      skipped_reason: "Learner not found or has no org",
    };
  }
  // Never move a learner a human has placed.
  if (learner.assigned_teacher_id) {
    return {
      assigned: false,
      teacher_id: null,
      reasons: [],
      skipped_reason: "Learner already has a teacher",
    };
  }

  const pool = await loadCandidatePool(learner.orgId.toString());
  if (pool.teachers.length === 0) {
    return {
      assigned: false,
      teacher_id: null,
      reasons: [],
      skipped_reason: "Org has no approved teachers",
    };
  }

  // Pass 1: full hard filters. Pass 2: drop the level gate (capacity
  // is never dropped) — an imperfect teacher beats no teacher.
  let best = rankPool(pool, learner, true).find((m) => m.eligible);
  if (!best) best = rankPool(pool, learner, false).find((m) => m.eligible);
  if (!best) {
    return {
      assigned: false,
      teacher_id: null,
      reasons: [],
      skipped_reason: "All teachers at capacity",
    };
  }

  await User.updateOne(
    { _id: learner._id, assigned_teacher_id: null }, // guard vs races
    { $set: { assigned_teacher_id: new Types.ObjectId(best.teacher_id) } },
  );

  const reasonText =
    best.reasons.length > 0 ? best.reasons.join("; ") : "Least-loaded teacher";
  await AuditLog.create({
    timestamp: new Date(),
    actor_type: actor ? "org_admin" : "system",
    actor_id: actor ? new Types.ObjectId(actor.callerId) : null,
    org_id: learner.orgId,
    learner_id: learner._id,
    action: "learner_teacher_assigned",
    before_state: { assigned_teacher_id: null },
    after_state: { assigned_teacher_id: best.teacher_id },
    reason: `Auto-assigned (best match): ${reasonText}`,
    compliance_config_version: null,
  }).catch((err) =>
    logger.error(
      { err: (err as Error).message, learnerId: String(learnerId) },
      "autoAssignTeacherForLearner: AuditLog write failed",
    ),
  );

  logger.info(
    {
      learnerId: String(learnerId),
      teacherId: best.teacher_id,
      score: best.score,
      reasons: best.reasons,
    },
    "Learner auto-assigned to best-match teacher",
  );

  return {
    assigned: true,
    teacher_id: best.teacher_id,
    reasons: best.reasons,
    skipped_reason: null,
  };
};

// ─────────────────────────────────────────────────────────────────────
// autoAssignUnassignedForOrg — org-admin bulk action
// ─────────────────────────────────────────────────────────────────────

export const autoAssignUnassignedForOrg = async (
  callerOrgId: string,
  callerId: string,
): Promise<ApiResponse> => {
  if (!callerOrgId || !Types.ObjectId.isValid(callerOrgId)) {
    throw new ApiError(400, "Organisation context required");
  }
  const unassigned = await User.find({
    role: "student",
    orgId: new Types.ObjectId(callerOrgId),
    isActive: true,
    assigned_teacher_id: null,
  })
    .select("_id")
    .lean();

  let assignedCount = 0;
  let skippedCount = 0;
  const skippedReasons = new Map<string, number>();

  // Sequential on purpose — each assignment changes the load counts
  // the next decision depends on. Org cohorts are small enough that
  // this completes in well under a second per hundred learners.
  for (const l of unassigned) {
    const result = await autoAssignTeacherForLearner(l._id, { callerId });
    if (result.assigned) {
      assignedCount += 1;
    } else {
      skippedCount += 1;
      const key = result.skipped_reason ?? "Unknown";
      skippedReasons.set(key, (skippedReasons.get(key) ?? 0) + 1);
    }
  }

  return new ApiResponse(200, "Auto-assignment complete", {
    total_unassigned: unassigned.length,
    assigned: assignedCount,
    skipped: skippedCount,
    skipped_reasons: Object.fromEntries(skippedReasons),
  });
};
