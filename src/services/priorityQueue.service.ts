/**
 * Teacher-priority scoring — Final Addendum §10, Todo 23.1.
 *
 *   evaluatePriority(learner_id) → { level, recommended_action, reason }
 *
 * Computes the priority tier (P1–P4) that surfaces a learner in the
 * teacher dashboard's priority queue. Eight trigger evaluators are
 * run in declaration order; the first one that fires wins. The
 * remaining triggers are short-circuited — by design, the highest-
 * severity reason for action is the only one a teacher needs to see
 * at the top of the card.
 *
 * Trigger order (first match wins)
 * ================================
 *
 *   P1 — Immediate intervention
 *     1. Active safeguarding alert unresolved
 *     2. 14+ days since last session AND learner enrolled >30 days
 *     3. Last 3 sessions all scored below 0.40 (struggling)
 *
 *   P2 — Within 7 days
 *     4. 7-13 days since last session AND learner enrolled >30 days
 *     5. Vocab retention dropped >20% in last 14 days
 *     6. Stage 3 objective hasn't been touched in 21+ days
 *
 *   P3 — Within 14 days
 *     7. 5-6 days since last session
 *     8. Avg session score 0.40-0.55 over last 5 sessions (steady but low)
 *     9. Eligible for level progression but not yet flagged
 *
 *   P4 — Maintenance (no trigger fired)
 *
 * Reading from
 * ============
 *
 *   User                  enrollment, current level, last_session_at,
 *                         stage3_objectives, progression_notification_level
 *   AISession             last-N-sessions scores, stage3_objective_ids
 *                         touches, recency
 *   VocabLedger           retained/total now vs 14d ago (retention drift)
 *   SafeguardingAlert     open + unresolved count
 *
 * Caching
 * =======
 *
 * The daily cron evaluates every learner in every org. Within a
 * single cron run the same intermediate aggregations (e.g. last-5
 * session scores) can be re-derived per learner — so the public
 * entrypoint accepts an optional `runId`. When set, each
 * intermediate read writes its result to a Redis key namespaced by
 * `priority:run:{runId}:learner:{id}:{kind}` with a 1-hour TTL.
 *
 * The TTL choice is deliberate: long enough that the daily cron
 * (typical wall-clock 3–10 mins) cannot outrun it; short enough
 * that a crashed cron's residual keys don't survive past the next
 * day's run. The keyspace pattern allows ops to `DEL priority:run:*`
 * if a forensic re-run is needed.
 *
 * When called WITHOUT a runId (e.g. on-demand from a session-
 * completion handler), caching is skipped — the value is fresh
 * by definition and persisting a single-shot eval pollutes Redis.
 *
 * Side effects
 * ============
 *
 * `evaluatePriority` is a PURE COMPUTE. It does NOT write the
 * verdict back to `User.teacher_priority_level` — that's the
 * caller's job (the cron writer / session-completion handler).
 * Keeping the compute pure means it stays testable end-to-end
 * without mocking writes, and ad-hoc callers (the teacher dashboard
 * "what would I score now?" preview) can read a verdict without
 * mutating state.
 */

import { Types } from "mongoose";
import User from "../models/User";
import AISession from "../models/AISession";
import VocabLedger from "../models/VocabLedger";
import SafeguardingAlert from "../models/SafeguardingAlert";
import { redis } from "../lib/redis";
import logger from "../config/logger";
import { checkLevelProgression } from "./levelProgression.service";

// ─────────────────────────────────────────────────────────────────────
// Public shapes
// ─────────────────────────────────────────────────────────────────────

export type PriorityLevel = "p1" | "p2" | "p3" | "p4";

/**
 * Stable identifier for the trigger that fired (or `healthy_maintenance`
 * when none did). Mirrors the top-level keys in
 * `src/data/recommended-actions.json` so callers can look up the
 * teacher-facing localised string without re-deriving the trigger
 * by parsing the text. Worker writes use the JSON deck; ad-hoc
 * callers (dashboard preview) can render `recommended_action`
 * directly when they don't care about localisation.
 */
export type PriorityTriggerKey =
  | "safeguarding_alert_unresolved"
  | "dormant_active_learner"
  | "struggling_score"
  | "inactive_7_13_days"
  | "vocab_retention_drop"
  | "stage3_stagnant"
  | "inactive_5_6_days"
  | "low_average_score"
  | "ready_for_progression"
  | "healthy_maintenance";

export interface PriorityVerdict {
  level: PriorityLevel;
  trigger_key: PriorityTriggerKey;
  /**
   * Context-rich, English, runtime-interpolated string (e.g.
   * "Re-engage urgently — no session for 17 days…"). Useful for
   * logs and the dashboard preview. For teacher-facing UI prefer
   * the localised template under `trigger_key`.
   */
  recommended_action: string;
  reason: string;
}

export interface EvaluatePriorityOptions {
  /**
   * When set, intermediate per-learner reads are cached under
   * `priority:run:{runId}:learner:{id}:{kind}` with a 1-hour TTL.
   * The daily cron should pass a stable runId (e.g. the BullMQ
   * job id of the parent cron tick) so two scoring jobs in the
   * same run share results. Omit for ad-hoc evals.
   */
  runId?: string;
}

// ─────────────────────────────────────────────────────────────────────
// Thresholds — central knobs the brief calls out
// ─────────────────────────────────────────────────────────────────────

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DAYS = (n: number) => n * MS_PER_DAY;

/** "Active learner" anchor — only fire dormancy triggers for
 *  learners who have been on the platform long enough that
 *  inactivity reads as intent, not onboarding gap. */
const ENROLLED_THRESHOLD_DAYS = 30;

/** P1 dormancy: ≥ this many days since last session. */
const P1_DORMANT_DAYS = 14;

/** P2 dormancy range: 7..13 (inclusive). */
const P2_DORMANT_MIN_DAYS = 7;
const P2_DORMANT_MAX_DAYS = 13;

/** P3 dormancy range: 5..6 (inclusive). */
const P3_DORMANT_MIN_DAYS = 5;
const P3_DORMANT_MAX_DAYS = 6;

/** Struggling: last N sessions all below this final_score. */
const STRUGGLING_LOOKBACK = 3;
const STRUGGLING_SCORE_CEILING = 0.4;

/** Steady-but-low: average over last N sessions in [min, max]. */
const STEADY_LOW_LOOKBACK = 5;
const STEADY_LOW_MIN_AVG = 0.4;
const STEADY_LOW_MAX_AVG = 0.55;

/** Vocab retention drift window + magnitude. */
const VOCAB_RECENT_WINDOW_DAYS = 14;
const VOCAB_BASELINE_WINDOW_DAYS = 60;
const VOCAB_DRIFT_DROP_THRESHOLD = 0.2; // 20 percentage points

/** Stage 3 objective neglect window. */
const OBJECTIVE_NEGLECT_DAYS = 21;

/** Redis cache TTL — long enough to span a cron run, short enough
 *  that a crashed cron's keys don't survive the next day. */
const CACHE_TTL_SECONDS = 60 * 60;

// ─────────────────────────────────────────────────────────────────────
// Recommended-action templates (Todo 23.2 will replace with the
// authoritative copy deck; defaults here keep the surface stable).
// ─────────────────────────────────────────────────────────────────────

const ACTIONS = {
  safeguarding: (n: number) =>
    `Review ${n} open safeguarding alert${n === 1 ? "" : "s"} with the DSL before any further teacher contact.`,
  dormantP1: (days: number) =>
    `Re-engage urgently — no session for ${days} days. Send a check-in message and book a contact session this week.`,
  struggling: (avg: number, n: number) =>
    `Score the recent dip — last ${n} sessions averaged ${avg.toFixed(2)}. Schedule a 1:1 to diagnose the blocker.`,
  dormantP2: (days: number) =>
    `Nudge this learner — ${days} days since last session. A short message often re-starts the cadence.`,
  vocabDrift: (recent: number, baseline: number) =>
    `Vocab retention dropped ${(baseline - recent).toFixed(0)} pp (${baseline.toFixed(0)}% → ${recent.toFixed(0)}%). Plan a consolidation session this week.`,
  objectiveStale: (days: number, domain: string) =>
    `Stage 3 objective in ${domain} hasn't been touched in ${days} days. Steer the next scenario toward it.`,
  dormantP3: (days: number) =>
    `Check in within two weeks — ${days} days since last session. No urgency yet, but momentum is slipping.`,
  steadyLow: (avg: number, n: number) =>
    `Steady-but-low — last ${n} sessions averaged ${avg.toFixed(2)}. Review their pathway; a different scenario mix may unblock the plateau.`,
  progressionReady:
    "All five level-progression criteria are met but the org admin hasn't been notified yet. Flag for review.",
  maintenance:
    "No action needed right now. Healthy progression — schedule the usual fortnightly check-in.",
};

// ─────────────────────────────────────────────────────────────────────
// Top-level entry
// ─────────────────────────────────────────────────────────────────────

export const evaluatePriority = async (
  learner_id: string,
  options: EvaluatePriorityOptions = {},
): Promise<PriorityVerdict> => {
  if (!learner_id || !Types.ObjectId.isValid(learner_id)) {
    throw new Error("evaluatePriority: learner_id must be a valid ObjectId");
  }
  const learnerObjectId = new Types.ObjectId(learner_id);
  const cache = makeCache(options.runId, learner_id);
  const now = Date.now();

  // ── Load the learner skeleton ──────────────────────────────────
  // Used by every trigger. Cheap projection — no populate.
  const learner = await cache.getOrLoad<LearnerSkeleton | null>(
    "learner",
    () =>
      User.findById(learnerObjectId)
        .select(
          "_id role esolLevel createdAt last_session_at stage3_objectives " +
            "progression_notification_level",
        )
        .lean<LearnerSkeleton | null>(),
  );
  if (!learner) {
    // Treat as P4-maintenance so the cron doesn't blow up; the
    // dashboard list never includes a vanished learner.
    return {
      level: "p4",
      trigger_key: "healthy_maintenance",
      recommended_action: ACTIONS.maintenance,
      reason: "Learner not found — treating as maintenance.",
    };
  }
  if (learner.role !== "student") {
    return {
      level: "p4",
      trigger_key: "healthy_maintenance",
      recommended_action: ACTIONS.maintenance,
      reason: "Not a student — priority queue does not apply.",
    };
  }

  const enrolledDays = learner.createdAt
    ? Math.floor((now - learner.createdAt.getTime()) / MS_PER_DAY)
    : 0;
  const daysSinceLastSession = learner.last_session_at
    ? Math.floor((now - learner.last_session_at.getTime()) / MS_PER_DAY)
    : null;

  // ── Triggers, in evaluation order — first match wins ──────────

  // P1.1 — Active safeguarding alert unresolved
  const safeguardingHit = await evalSafeguarding(learnerObjectId, cache);
  if (safeguardingHit) return safeguardingHit;

  // P1.2 — 14+ days dormant AND enrolled >30 days
  if (
    enrolledDays > ENROLLED_THRESHOLD_DAYS &&
    daysSinceLastSession !== null &&
    daysSinceLastSession >= P1_DORMANT_DAYS
  ) {
    return {
      level: "p1",
      trigger_key: "dormant_active_learner",
      recommended_action: ACTIONS.dormantP1(daysSinceLastSession),
      reason: `Active learner (${enrolledDays}d enrolled) has been dormant for ${daysSinceLastSession} days.`,
    };
  }

  // P1.3 — Last 3 sessions all below 0.40
  const strugglingHit = await evalStruggling(learnerObjectId, cache);
  if (strugglingHit) return strugglingHit;

  // P2.4 — 7-13 days dormant AND enrolled >30 days
  if (
    enrolledDays > ENROLLED_THRESHOLD_DAYS &&
    daysSinceLastSession !== null &&
    daysSinceLastSession >= P2_DORMANT_MIN_DAYS &&
    daysSinceLastSession <= P2_DORMANT_MAX_DAYS
  ) {
    return {
      level: "p2",
      trigger_key: "inactive_7_13_days",
      recommended_action: ACTIONS.dormantP2(daysSinceLastSession),
      reason: `Active learner (${enrolledDays}d enrolled) has not been seen for ${daysSinceLastSession} days.`,
    };
  }

  // P2.5 — Vocab retention dropped >20 pp in last 14d
  const vocabHit = await evalVocabDrift(learnerObjectId, cache);
  if (vocabHit) return vocabHit;

  // P2.6 — Stage 3 objective stale ≥ 21 days
  const objectiveHit = await evalStaleObjective(
    learnerObjectId,
    learner.stage3_objectives ?? [],
    cache,
  );
  if (objectiveHit) return objectiveHit;

  // P3.7 — 5-6 days dormant (no enrolment-floor — short windows
  // are still useful prep nudges even for new learners).
  if (
    daysSinceLastSession !== null &&
    daysSinceLastSession >= P3_DORMANT_MIN_DAYS &&
    daysSinceLastSession <= P3_DORMANT_MAX_DAYS
  ) {
    return {
      level: "p3",
      trigger_key: "inactive_5_6_days",
      recommended_action: ACTIONS.dormantP3(daysSinceLastSession),
      reason: `${daysSinceLastSession} days since last session — gentle re-engagement window.`,
    };
  }

  // P3.8 — Avg score 0.40-0.55 over last 5 sessions
  const steadyLowHit = await evalSteadyLow(learnerObjectId, cache);
  if (steadyLowHit) return steadyLowHit;

  // P3.9 — Eligible for level progression but not yet flagged
  // Skip if we have no current level (placement not run yet) —
  // checkLevelProgression returns a "not ready" verdict in that
  // case, so the test below is correct without a guard.
  const progressionHit = await evalProgressionReady(learner_id, learner, cache);
  if (progressionHit) return progressionHit;

  // P4 — Maintenance (everything is fine)
  return {
    level: "p4",
    trigger_key: "healthy_maintenance",
    recommended_action: ACTIONS.maintenance,
    reason: "No triggers fired — healthy learner on track.",
  };
};

// ─────────────────────────────────────────────────────────────────────
// Trigger evaluators
// ─────────────────────────────────────────────────────────────────────

/** P1.1 — open SafeguardingAlerts (status not in {resolved, dismissed}). */
const evalSafeguarding = async (
  learnerObjectId: Types.ObjectId,
  cache: Cache,
): Promise<PriorityVerdict | null> => {
  const openCount = await cache.getOrLoad<number>("safeguarding_open", () =>
    SafeguardingAlert.countDocuments({
      learnerId: learnerObjectId,
      status: { $in: ["open", "reviewed", "escalated"] },
    }),
  );
  if (openCount > 0) {
    return {
      level: "p1",
      trigger_key: "safeguarding_alert_unresolved",
      recommended_action: ACTIONS.safeguarding(openCount),
      reason: `${openCount} unresolved safeguarding alert${openCount === 1 ? "" : "s"} on file.`,
    };
  }
  return null;
};

/** P1.3 — last 3 graded sessions ALL < STRUGGLING_SCORE_CEILING. */
const evalStruggling = async (
  learnerObjectId: Types.ObjectId,
  cache: Cache,
): Promise<PriorityVerdict | null> => {
  // Most-recent N completed sessions with a numeric final_score.
  // Historical pre-platform imports have final_score: null and
  // therefore can't satisfy "scored below 0.40" — exclude them
  // from the lookback so they don't dilute the signal.
  const recent = await cache.getOrLoad<Array<{ final_score: number }>>(
    "recent_scored_sessions",
    () =>
      AISession.find({
        learnerId: learnerObjectId,
        completedAt: { $ne: null },
        final_score: { $ne: null },
      })
        .sort({ completedAt: -1 })
        .limit(STEADY_LOW_LOOKBACK) // covers both struggling (3) + steady-low (5)
        .select("final_score")
        .lean<Array<{ final_score: number }>>(),
  );
  if (recent.length < STRUGGLING_LOOKBACK) return null;
  const last3 = recent.slice(0, STRUGGLING_LOOKBACK);
  const allBelow = last3.every((s) => s.final_score < STRUGGLING_SCORE_CEILING);
  if (allBelow) {
    const avg = last3.reduce((a, s) => a + s.final_score, 0) / last3.length;
    return {
      level: "p1",
      trigger_key: "struggling_score",
      recommended_action: ACTIONS.struggling(avg, STRUGGLING_LOOKBACK),
      reason: `Last ${STRUGGLING_LOOKBACK} sessions all scored below ${STRUGGLING_SCORE_CEILING} (avg ${avg.toFixed(2)}).`,
    };
  }
  return null;
};

/**
 * P2.5 — vocab retention drift in the last 14d.
 *
 * "Dropped >20%" interpreted as: the retention rate among words
 * touched in the recent window is ≥ 20 percentage points below the
 * baseline window's rate. Because `retained: true` is sticky in
 * VocabLedger, the headline retention pct can only go up — what
 * we're really catching is a recent batch of new words failing to
 * convert. That's the signal a teacher needs to act on.
 *
 * Both windows need a minimum sample (3 words) to fire; tiny
 * cohorts produce noisy ratios that would spam P2.
 */
const evalVocabDrift = async (
  learnerObjectId: Types.ObjectId,
  cache: Cache,
): Promise<PriorityVerdict | null> => {
  const now = Date.now();
  const recentCutoff = new Date(now - DAYS(VOCAB_RECENT_WINDOW_DAYS));
  const baselineCutoff = new Date(now - DAYS(VOCAB_BASELINE_WINDOW_DAYS));

  // One aggregation, two buckets — single round-trip beats two finds.
  type Bucket = { _id: "recent" | "baseline"; total: number; retained: number };
  const buckets = await cache.getOrLoad<Bucket[]>(
    "vocab_drift_buckets",
    () =>
      VocabLedger.aggregate<Bucket>([
        {
          $match: {
            learnerId: learnerObjectId,
            last_seen_at: { $gte: baselineCutoff },
          },
        },
        {
          $project: {
            retained: { $cond: ["$retained", 1, 0] },
            bucket: {
              $cond: [
                { $gte: ["$last_seen_at", recentCutoff] },
                "recent",
                "baseline",
              ],
            },
          },
        },
        {
          $group: {
            _id: "$bucket",
            total: { $sum: 1 },
            retained: { $sum: "$retained" },
          },
        },
      ]),
  );

  const recent = buckets.find((b) => b._id === "recent");
  const baseline = buckets.find((b) => b._id === "baseline");
  const MIN_SAMPLE = 3;
  if (!recent || !baseline) return null;
  if (recent.total < MIN_SAMPLE || baseline.total < MIN_SAMPLE) return null;

  const recentPct = (recent.retained / recent.total) * 100;
  const baselinePct = (baseline.retained / baseline.total) * 100;
  if (baselinePct - recentPct >= VOCAB_DRIFT_DROP_THRESHOLD * 100) {
    return {
      level: "p2",
      trigger_key: "vocab_retention_drop",
      recommended_action: ACTIONS.vocabDrift(recentPct, baselinePct),
      reason:
        `Vocab retention dropped from ${baselinePct.toFixed(1)}% ` +
        `(prior ${VOCAB_BASELINE_WINDOW_DAYS - VOCAB_RECENT_WINDOW_DAYS}d) ` +
        `to ${recentPct.toFixed(1)}% (last ${VOCAB_RECENT_WINDOW_DAYS}d).`,
    };
  }
  return null;
};

/**
 * P2.6 — at least one Stage 3 objective hasn't been touched in
 * ≥ OBJECTIVE_NEGLECT_DAYS days.
 *
 * "Touched" = appears in some AISession.stage3_objective_ids. The
 * service finds the most-recent touch per objective via aggregation,
 * then flags the worst (longest-untouched) one.
 *
 * No objectives ⇒ no trigger (the learner is pre-objectives and
 * the dormancy triggers handle the slow-start case).
 */
const evalStaleObjective = async (
  learnerObjectId: Types.ObjectId,
  stage3Objectives: Array<{ id: string; skill_domain?: string }>,
  cache: Cache,
): Promise<PriorityVerdict | null> => {
  if (!Array.isArray(stage3Objectives) || stage3Objectives.length === 0) {
    return null;
  }
  const now = Date.now();

  // Latest touch per objective_id. One pass over AISession with
  // an unwind + group; bounded by this learner's sessions only.
  type TouchAgg = { _id: string; last_touched: Date };
  const touches = await cache.getOrLoad<TouchAgg[]>(
    "objective_touches",
    () =>
      AISession.aggregate<TouchAgg>([
        {
          $match: {
            learnerId: learnerObjectId,
            completedAt: { $ne: null },
          },
        },
        {
          $project: {
            ids: { $ifNull: ["$stage3_objective_ids", []] },
            completedAt: 1,
          },
        },
        { $unwind: "$ids" },
        {
          $group: {
            _id: "$ids",
            last_touched: { $max: "$completedAt" },
          },
        },
      ]),
  );
  const touchById = new Map<string, Date>(
    touches.map((t) => [t._id, t.last_touched]),
  );

  // For each objective on the learner, compute days-since-touch.
  // An objective NEVER touched is treated as "set_at days ago" — a
  // brand-new objective shouldn't immediately fire stale.
  let worst: {
    objective: { id: string; skill_domain?: string };
    days_since: number;
  } | null = null;
  for (const obj of stage3Objectives) {
    const lastTouch = touchById.get(obj.id);
    const setAt = (obj as { set_at?: Date }).set_at;
    // Use last touch if present; otherwise fall back to set_at;
    // otherwise treat as "just set" (0 days).
    const anchor = lastTouch ?? setAt ?? new Date(now);
    const days = Math.floor((now - anchor.getTime()) / MS_PER_DAY);
    if (days >= OBJECTIVE_NEGLECT_DAYS) {
      if (!worst || days > worst.days_since) {
        worst = { objective: obj, days_since: days };
      }
    }
  }

  if (worst) {
    const domain = worst.objective.skill_domain ?? "unknown domain";
    return {
      level: "p2",
      trigger_key: "stage3_stagnant",
      recommended_action: ACTIONS.objectiveStale(worst.days_since, domain),
      reason: `Stage 3 objective ${worst.objective.id} (${domain}) last touched ${worst.days_since} days ago.`,
    };
  }
  return null;
};

/** P3.8 — average score over last 5 graded sessions in [0.40, 0.55]. */
const evalSteadyLow = async (
  learnerObjectId: Types.ObjectId,
  cache: Cache,
): Promise<PriorityVerdict | null> => {
  // Re-uses the same cache key the struggling evaluator populates
  // — the lookback size (5) is shared.
  const recent = await cache.getOrLoad<Array<{ final_score: number }>>(
    "recent_scored_sessions",
    () =>
      AISession.find({
        learnerId: learnerObjectId,
        completedAt: { $ne: null },
        final_score: { $ne: null },
      })
        .sort({ completedAt: -1 })
        .limit(STEADY_LOW_LOOKBACK)
        .select("final_score")
        .lean<Array<{ final_score: number }>>(),
  );
  if (recent.length < STEADY_LOW_LOOKBACK) return null;
  const avg = recent.reduce((a, s) => a + s.final_score, 0) / recent.length;
  if (avg >= STEADY_LOW_MIN_AVG && avg <= STEADY_LOW_MAX_AVG) {
    return {
      level: "p3",
      trigger_key: "low_average_score",
      recommended_action: ACTIONS.steadyLow(avg, STEADY_LOW_LOOKBACK),
      reason: `Average score over last ${STEADY_LOW_LOOKBACK} sessions is ${avg.toFixed(2)} — steady but below progression threshold.`,
    };
  }
  return null;
};

/**
 * P3.9 — eligible for level progression (5 criteria met) but the
 * org-admin notification hasn't yet been sent for the CURRENT level.
 *
 * `progression_notification_level` is set on the User by the daily
 * progression cron when it notifies. If it matches the learner's
 * current level, the org admin has already been told — no need to
 * surface the same readiness on the teacher's queue.
 */
const evalProgressionReady = async (
  learner_id: string,
  learner: LearnerSkeleton,
  cache: Cache,
): Promise<PriorityVerdict | null> => {
  if (!learner.esolLevel) return null;
  const verdict = await cache.getOrLoad("progression_check", () =>
    checkLevelProgression(learner_id),
  );
  if (!verdict.ready_for_progression) return null;

  // Already notified at this level?
  if (
    learner.progression_notification_level &&
    learner.progression_notification_level === learner.esolLevel
  ) {
    return null;
  }
  return {
    level: "p3",
    trigger_key: "ready_for_progression",
    recommended_action: ACTIONS.progressionReady,
    reason: `All five progression criteria met at ${learner.esolLevel.toUpperCase()}, but the org admin hasn't been notified yet.`,
  };
};

// ─────────────────────────────────────────────────────────────────────
// Cache wrapper — namespaced per (runId, learner_id)
// ─────────────────────────────────────────────────────────────────────

interface Cache {
  /**
   * Read from Redis under the cache key; fall back to `loader()`
   * on miss and populate the key. When the wrapper was created
   * without a runId (no caching), `loader()` is always invoked.
   */
  getOrLoad<T>(kind: string, loader: () => Promise<T>): Promise<T>;
}

const makeCache = (runId: string | undefined, learner_id: string): Cache => {
  if (!runId) {
    // No caching — direct passthrough.
    return {
      getOrLoad: async (_kind, loader) => loader(),
    };
  }
  const baseKey = `priority:run:${runId}:learner:${learner_id}`;
  return {
    getOrLoad: async <T>(kind: string, loader: () => Promise<T>): Promise<T> => {
      const key = `${baseKey}:${kind}`;
      try {
        const cached = await redis.get(key);
        if (cached !== null) {
          // ioredis returns string | null; values are JSON-serialised.
          return JSON.parse(cached, reviveDates) as T;
        }
      } catch (err) {
        logger.warn(
          { err: (err as Error).message, key },
          "priorityQueue: Redis GET failed — falling back to loader",
        );
      }
      const value = await loader();
      // Fire-and-forget write — a Redis hiccup must not fail the eval.
      redis
        .set(key, JSON.stringify(value), "EX", CACHE_TTL_SECONDS)
        .catch((err) =>
          logger.warn(
            { err: (err as Error).message, key },
            "priorityQueue: Redis SET failed — eval succeeded but cache miss next call",
          ),
        );
      return value;
    },
  };
};

/**
 * JSON.parse reviver — strings that look like ISO-8601 timestamps
 * get re-hydrated to Date. Mongoose date fields round-trip through
 * the cache and the evaluators expect Date instances (e.g.
 * `.getTime()` on `last_touched`).
 */
const ISO_DATE_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const reviveDates = (_key: string, value: unknown): unknown => {
  if (typeof value === "string" && ISO_DATE_PATTERN.test(value)) {
    return new Date(value);
  }
  return value;
};

// ─────────────────────────────────────────────────────────────────────
// Internal types
// ─────────────────────────────────────────────────────────────────────

interface LearnerSkeleton {
  _id: Types.ObjectId;
  role: string;
  esolLevel: string | null;
  createdAt: Date;
  last_session_at: Date | null;
  stage3_objectives: Array<{
    id: string;
    skill_domain?: string;
    set_at?: Date;
  }>;
  progression_notification_level: string | null;
}

// ─────────────────────────────────────────────────────────────────────
// Test exports — internals surface for unit tests
// ─────────────────────────────────────────────────────────────────────

export const __internals__ = {
  ACTIONS,
  CACHE_TTL_SECONDS,
  ENROLLED_THRESHOLD_DAYS,
  OBJECTIVE_NEGLECT_DAYS,
  P1_DORMANT_DAYS,
  P2_DORMANT_MAX_DAYS,
  P2_DORMANT_MIN_DAYS,
  P3_DORMANT_MAX_DAYS,
  P3_DORMANT_MIN_DAYS,
  STEADY_LOW_LOOKBACK,
  STEADY_LOW_MAX_AVG,
  STEADY_LOW_MIN_AVG,
  STRUGGLING_LOOKBACK,
  STRUGGLING_SCORE_CEILING,
  VOCAB_BASELINE_WINDOW_DAYS,
  VOCAB_DRIFT_DROP_THRESHOLD,
  VOCAB_RECENT_WINDOW_DAYS,
  evalProgressionReady,
  evalSafeguarding,
  evalStaleObjective,
  evalSteadyLow,
  evalStruggling,
  evalVocabDrift,
  reviveDates,
};
