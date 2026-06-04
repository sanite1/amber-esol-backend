/**
 * ILR GLH formula — Final Addendum §12.
 *
 * Single source of truth for the `total_glh` computation that
 * lands in ILR's `AddHours` (regulated aim) or overall GLH
 * (non-regulated aim).
 *
 * The brief's formula:
 *
 *   total_glh = ai_glh + pre_platform_glh + teacher_contact_glh
 *
 * where:
 *   - ai_glh             = Σ AISession.duration_mins / 60
 *                          where session_source === "ai_tutor"
 *   - pre_platform_glh   = Σ AISession.duration_mins / 60
 *                          where session_source === "pre_platform"
 *   - teacher_contact_glh = User.glh_teacher_contact
 *
 * teacher_consolidation sessions
 * ==============================
 *
 * The brief's formula has three terms, not four. AISession has a
 * third `session_source` value (`teacher_consolidation`) that
 * we DELIBERATELY exclude from this total — those sessions are
 * the teacher's follow-up work on a learner, and a TeacherReview
 * row is written alongside that ALREADY increments
 * `User.glh_teacher_contact`. Counting the session's
 * `duration_mins` here would double-count the same hour.
 *
 * The split is documented in the return shape (`teacher_consolidation_glh`
 * surfaces separately so the caller can sanity-check the
 * accounting; it just doesn't roll into `total_glh`).
 *
 * Why a separate file
 * ===================
 *
 * The current `buildRowForSession` in ilrExport.service.ts
 * computes a per-session `glhForRow = sessionHours +
 * teacherContactHours` and emits one ILR row per session — that
 * double-counts `teacher_contact_glh` across every row a learner
 * has. Fixing buildIlrRows to emit one row per learner-aim
 * (rather than one row per session) is a Phase 14.1 follow-up;
 * lifting the formula into a pure function now means the fix
 * has a tested target to wire into.
 */

import { Types } from "mongoose";

// ─────────────────────────────────────────────────────────────────────
// Public shapes
// ─────────────────────────────────────────────────────────────────────

export type IlrGlhSessionSource =
  | "ai_tutor"
  | "teacher_consolidation"
  | "pre_platform";

/**
 * Minimum session shape the formula needs. Keeps the helper
 * decoupled from the full AISession document so the test can
 * exercise it with plain objects.
 */
export interface IlrGlhSessionInput {
  duration_mins: number | null | undefined;
  session_source: IlrGlhSessionSource | string | null | undefined;
}

export interface IlrGlhBreakdown {
  ai_glh: number;
  pre_platform_glh: number;
  teacher_contact_glh: number;
  /** Excluded from total_glh — surfaced for sanity-check / audit. */
  teacher_consolidation_glh: number;
  /** Number of sessions whose `session_source` matched none of the known values. */
  unknown_source_count: number;
  /** total_glh = ai_glh + pre_platform_glh + teacher_contact_glh */
  total_glh: number;
}

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

/**
 * Convert minutes to hours, returning 0 on null / negative / NaN.
 * The negative guard is defensive — duration_mins is min: 0 on the
 * schema, but a hand-imported pre-platform row could carry a typo.
 */
const minsToHours = (mins: number | null | undefined): number => {
  if (typeof mins !== "number" || !Number.isFinite(mins) || mins < 0) {
    return 0;
  }
  return mins / 60;
};

/**
 * Round to 1 decimal place — ILR's AddHours field stores hours to
 * one dp. We round once at the end of summation to avoid
 * accumulating per-session rounding error (a session of 17 mins
 * is exactly 0.28333… hours; rounding each session to 0.3 then
 * summing 100 of those drifts ~2h).
 */
const round1dp = (n: number): number => Math.round(n * 10) / 10;

// ─────────────────────────────────────────────────────────────────────
// Top-level entry
// ─────────────────────────────────────────────────────────────────────

/**
 * Compute the three-term ILR GLH total for one learner.
 *
 * @param sessions          Every AISession for the learner in the
 *                          reporting window. Order doesn't matter;
 *                          we bucket and sum.
 * @param glhTeacherContact `User.glh_teacher_contact` — already
 *                          hours (the teacher review-log service
 *                          $inc's `duration_mins / 60`).
 *
 * Returns a breakdown with the per-source subtotals + the rolled-
 * up `total_glh`. Every subtotal is rounded to 1 dp; the total is
 * also rounded once at the end (re-rounding the sum of pre-
 * rounded subtotals can drift by ~0.05).
 */
export const computeIlrLearnerGlh = (
  sessions: ReadonlyArray<IlrGlhSessionInput>,
  glhTeacherContact: number | null | undefined,
): IlrGlhBreakdown => {
  let aiGlh = 0;
  let prePlatformGlh = 0;
  let teacherConsolidationGlh = 0;
  let unknownSourceCount = 0;

  for (const session of sessions) {
    const hours = minsToHours(session.duration_mins);
    if (hours === 0) continue;

    switch (session.session_source) {
      case "ai_tutor":
        aiGlh += hours;
        break;
      case "pre_platform":
        prePlatformGlh += hours;
        break;
      case "teacher_consolidation":
        teacherConsolidationGlh += hours;
        break;
      default:
        // Defensive — a legacy row with a missing/typo session_source
        // is counted nowhere and tallied so the caller can log the
        // surprise. Never silently bucketed into one of the known
        // categories (could over/under-count).
        unknownSourceCount += 1;
        break;
    }
  }

  const teacherContact =
    typeof glhTeacherContact === "number" && Number.isFinite(glhTeacherContact)
      ? Math.max(0, glhTeacherContact)
      : 0;

  // Round at the end, once. The full-precision sum drives the
  // total; the breakdown values get the same one-dp treatment so
  // the test can assert exact equality without floating-point
  // hand-wringing.
  const totalUnrounded = aiGlh + prePlatformGlh + teacherContact;

  return {
    ai_glh: round1dp(aiGlh),
    pre_platform_glh: round1dp(prePlatformGlh),
    teacher_contact_glh: round1dp(teacherContact),
    teacher_consolidation_glh: round1dp(teacherConsolidationGlh),
    unknown_source_count: unknownSourceCount,
    total_glh: round1dp(totalUnrounded),
  };
};

// ─────────────────────────────────────────────────────────────────────
// Test exports
// ─────────────────────────────────────────────────────────────────────

export const __internals__ = {
  minsToHours,
  round1dp,
};

// Keep mongoose import lookup alive for the Types reference in
// IlrGlhSessionInput shape evolution (e.g. when we add learnerId
// for the per-learner aggregator wrapper).
export const __types_keepalive__ = Types.ObjectId;
