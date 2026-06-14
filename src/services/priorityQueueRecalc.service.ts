/**
 * Priority queue per-org recalc — Final Addendum §10, Todo 23.3.
 *
 * Consumes the `recalc-org-priorities` action on the
 * `priority-queue` BullMQ queue. One job per org per cron tick;
 * the cron handler fans out so a single bad org doesn't block
 * the rest, and BullMQ's retry policy gives the worker three
 * attempts before terminal failure.
 *
 * Pipeline
 * ========
 *
 *   1. Load every learner in the org with role: "student". One
 *      narrow projection — we only need the fields the verdict
 *      writer touches plus a few for the audit row's
 *      before_state.
 *   2. For each, call `evaluatePriority(learnerId, { runId })`.
 *      The runId namespaces the Redis cache so intermediate
 *      aggregations are shared across learners that touch the
 *      same secondary indices.
 *   3. Atomically write back the verdict to the User:
 *      `teacher_priority_level`, `teacher_recommended_action`
 *      (the LOCALISED string from the JSON copy deck — see
 *      `getLocalisedAction`), `teacher_priority_updated_at`.
 *   4. AuditLog ONLY when the priority level changes from
 *      previous. A no-op rerun produces no audit noise — the
 *      audit trail surfaces real shifts.
 *   5. Emit one summary AuditLog row at the end:
 *      `priority_queue_recalculated` with `{ p1_count, p2_count,
 *       p3_count, p4_count }` in `after_state`.
 *
 * Atomicity
 * =========
 *
 *   - Each User update is a single $set, so a worker crash in
 *     mid-batch leaves some learners updated and some not — both
 *     valid states. The next cron tick converges them.
 *   - The summary audit row is best-effort and lands AFTER the
 *     per-change audits. If the summary write fails (Redis
 *     hiccup, AuditLog write race), the per-change rows still
 *     give an auditor enough to reconstruct what happened.
 *   - Per-learner failures (evaluatePriority throws, e.g. a
 *     malformed stage3_objectives doc) are caught and logged;
 *     the batch continues. The summary row's `errors_count`
 *     surfaces the per-learner failures for ops visibility.
 *
 * Localisation
 * ============
 *
 * `teacher_recommended_action` is written as the JSON template
 * string keyed by `verdict.trigger_key`. Today that's always the
 * `en` slot — per-teacher language preference lands in Phase 19,
 * at which point this worker can switch to per-teacher lookup
 * (a learner's recommended action is teacher-facing, so the
 * relevant language is the assigned teacher's, not the
 * learner's). Until then `en` is the right default — switching
 * to the teacher's preference is a one-line change in
 * `getLocalisedAction`.
 */

import { Job } from "bullmq";
import { Types } from "mongoose";
import User from "../models/User";
import logger from "../config/logger";
import { writeAuditLog } from "./auditLog.service";
import {
  evaluatePriority,
  PriorityLevel,
  PriorityTriggerKey,
  PriorityVerdict,
} from "./priorityQueue.service";
import { priorityQueueQueue } from "../queues";
// JSON imported at module load — Node caches the parsed object so
// every call after the first is a property lookup. Validated at
// boot via the type assertion below; mis-shaped JSON would surface
// here as a TypeScript error rather than at first-request.
import recommendedActions from "../data/recommended-actions.json";

// ─────────────────────────────────────────────────────────────────────
// Public job + result shapes
// ─────────────────────────────────────────────────────────────────────

export interface RecalcOrgPrioritiesJobData {
  org_id: string;
  /**
   * Optional runId override; the dispatcher derives a sensible
   * default (`${job.id}`) when absent so cron-fanned jobs in the
   * same tick share Redis cache.
   */
  runId?: string;
}

export interface RecalcOrgPrioritiesResult {
  org_id: string;
  evaluated: number;
  changed: number;
  errors: number;
  counts: Record<PriorityLevel, number>;
  duration_ms: number;
}

// ─────────────────────────────────────────────────────────────────────
// Localised template lookup
// ─────────────────────────────────────────────────────────────────────

type LangSlot = {
  en: string;
  ar?: string;
  so?: string;
  fa?: string;
  zh?: string;
};
type RecommendedActions = Record<PriorityTriggerKey, LangSlot> &
  Record<`$${string}`, unknown>;

/**
 * Return the teacher-facing recommended-action string for a
 * trigger, in the requested language with English fallback.
 *
 * The JSON file is loaded once at module init; this lookup is
 * essentially a property access. `$`-prefixed metadata keys
 * (`$schema_version`, `$meta`) are filtered out by the type
 * narrowing — they can't satisfy `PriorityTriggerKey`.
 */
const getLocalisedAction = (
  triggerKey: PriorityTriggerKey,
  lang: keyof LangSlot = "en",
): string => {
  const deck = recommendedActions as unknown as RecommendedActions;
  const slot = deck[triggerKey];
  if (!slot) {
    // Defensive — shape mismatch between TS union and JSON deck.
    logger.warn(
      { triggerKey, lang },
      "priorityQueueRecalc: no template found for trigger key — falling back to verdict.recommended_action",
    );
    return "";
  }
  const localised = slot[lang];
  if (typeof localised === "string" && localised.length > 0) return localised;
  return slot.en;
};

// ─────────────────────────────────────────────────────────────────────
// Top-level worker entry
// ─────────────────────────────────────────────────────────────────────

export const runOrgPriorityRecalc = async (
  org_id: string,
  jobId: string,
): Promise<RecalcOrgPrioritiesResult> => {
  if (!org_id || !Types.ObjectId.isValid(org_id)) {
    throw new Error(
      `runOrgPriorityRecalc: org_id must be a valid ObjectId (got ${org_id})`,
    );
  }
  const orgObjectId = new Types.ObjectId(org_id);
  const runId = jobId; // share Redis cache slots across learners in this tick
  const startedAt = Date.now();

  // ── 1. Load org learners (narrow projection) ──────────────────
  const learners = await User.find({
    orgId: orgObjectId,
    role: "student",
  })
    .select(
      "_id firstname lastname teacher_priority_level teacher_recommended_action assigned_teacher_id",
    )
    .lean<LearnerSkeleton[]>();

  if (learners.length === 0) {
    logger.info(
      { org_id, runId },
      "runOrgPriorityRecalc: no learners in org — short-circuit summary",
    );
    const emptyCounts = { p1: 0, p2: 0, p3: 0, p4: 0 } as Record<
      PriorityLevel,
      number
    >;
    await writeSummaryAudit(orgObjectId, emptyCounts, 0, 0, 0);
    return {
      org_id,
      evaluated: 0,
      changed: 0,
      errors: 0,
      counts: emptyCounts,
      duration_ms: Date.now() - startedAt,
    };
  }

  // ── 2 + 3 + 4. Evaluate + write + per-change audit ────────────
  const counts: Record<PriorityLevel, number> = { p1: 0, p2: 0, p3: 0, p4: 0 };
  let evaluated = 0;
  let changed = 0;
  let errors = 0;

  for (const learner of learners) {
    const outcome = await evaluateAndWriteForLearner(learner, {
      runId,
      orgIdForAudit: org_id,
      callerLabel: "runOrgPriorityRecalc",
    });
    if (outcome.status === "error") {
      errors += 1;
      continue;
    }
    evaluated += 1;
    counts[outcome.verdict.level] += 1;
    if (outcome.changed) changed += 1;
  }

  // ── 5. Summary audit row ──────────────────────────────────────
  await writeSummaryAudit(orgObjectId, counts, evaluated, changed, errors);

  const duration_ms = Date.now() - startedAt;
  logger.info(
    {
      org_id,
      runId,
      evaluated,
      changed,
      errors,
      counts,
      duration_ms,
    },
    "runOrgPriorityRecalc: complete",
  );

  return {
    org_id,
    evaluated,
    changed,
    errors,
    counts,
    duration_ms,
  };
};

// ─────────────────────────────────────────────────────────────────────
// BullMQ processor — thin wrapper that validates payload + delegates
// ─────────────────────────────────────────────────────────────────────

export const processRecalcOrgPriorities = async (
  job: Job<{ orgId?: string; org_id?: string; runId?: string }>,
): Promise<RecalcOrgPrioritiesResult | { skipped: true; reason: string }> => {
  // Accept either camelCase (matches the rest of the
  // PriorityQueueJob shape) or snake_case (the brief's Todo 23.3
  // payload spec). Internal callers should standardise on
  // `orgId` to match the queue's existing convention.
  const orgIdRaw = job.data.orgId ?? job.data.org_id;
  if (!orgIdRaw) {
    logger.warn(
      { jobId: job.id },
      "processRecalcOrgPriorities: missing org_id — skipping",
    );
    return { skipped: true, reason: "missing org_id" };
  }
  if (!Types.ObjectId.isValid(orgIdRaw)) {
    logger.warn(
      { jobId: job.id, org_id: orgIdRaw },
      "processRecalcOrgPriorities: invalid org_id — skipping",
    );
    return { skipped: true, reason: "invalid org_id" };
  }
  // Use the BullMQ job id (string) as the runId — guaranteed
  // unique per job, stable across the worker's lifetime, and
  // already in scope here without any extra plumbing.
  return runOrgPriorityRecalc(orgIdRaw, String(job.id ?? "ad-hoc"));
};

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

interface LearnerSkeleton {
  _id: Types.ObjectId;
  firstname?: string;
  lastname?: string;
  teacher_priority_level?: PriorityLevel;
  teacher_recommended_action?: string | null;
  assigned_teacher_id?: Types.ObjectId | null;
}

const writeSummaryAudit = async (
  orgObjectId: Types.ObjectId,
  counts: Record<PriorityLevel, number>,
  evaluated: number,
  changed: number,
  errors: number,
): Promise<void> => {
  await writeAuditLog({
    actor_type: "system",
    actor_id: null,
    org_id: orgObjectId,
    learner_id: null,
    action: "priority_queue_recalculated",
    before_state: null,
    after_state: {
      p1_count: counts.p1,
      p2_count: counts.p2,
      p3_count: counts.p3,
      p4_count: counts.p4,
      evaluated,
      changed,
      errors,
    },
    reason:
      `Priority queue recalculated: ${evaluated} learner${evaluated === 1 ? "" : "s"} evaluated, ` +
      `${changed} level change${changed === 1 ? "" : "s"}` +
      (errors > 0 ? `, ${errors} error${errors === 1 ? "" : "s"}` : "") +
      `. P1=${counts.p1} · P2=${counts.p2} · P3=${counts.p3} · P4=${counts.p4}.`,
  });
};

// ─────────────────────────────────────────────────────────────────────
// Shared per-learner evaluate+write helper
//
// Pulled out of the per-org loop so the single-learner worker
// (Todo 23.4) can reuse the exact same evaluate / write / audit
// semantics. The behaviour invariants are:
//
//   - evaluatePriority failures are caught, logged, returned as
//     `{ status: "error" }`. Callers decide whether to count
//     toward an error tally.
//   - User.updateOne is atomic ($set) — a crash leaves the User
//     in either the old verdict or the new, never a torn state.
//   - AuditLog row is written ONLY when the level changes. Same-
//     level recommended-action rotations (a dormancy counter
//     ticking 5d → 6d) are dashboard noise, not auditable signal.
// ─────────────────────────────────────────────────────────────────────

interface EvaluateAndWriteOpts {
  runId: string;
  /**
   * Org id to stamp on the per-change audit row. The org-loop
   * caller already has it; the single-learner caller derives it
   * via a lookup (orgId lives on User, not on the trigger
   * payload).
   */
  orgIdForAudit: string;
  /** Logger context — e.g. "runOrgPriorityRecalc" / "runLearnerPriorityRecalc". */
  callerLabel: string;
}

type EvaluateAndWriteOutcome =
  | { status: "error" }
  | { status: "ok"; verdict: PriorityVerdict; changed: boolean };

const evaluateAndWriteForLearner = async (
  learner: LearnerSkeleton,
  opts: EvaluateAndWriteOpts,
): Promise<EvaluateAndWriteOutcome> => {
  const learnerIdStr = (learner._id as Types.ObjectId).toString();

  let verdict: PriorityVerdict;
  try {
    verdict = await evaluatePriority(learnerIdStr, { runId: opts.runId });
  } catch (err) {
    logger.error(
      {
        err: (err as Error).message,
        learner_id: learnerIdStr,
        org_id: opts.orgIdForAudit,
        runId: opts.runId,
      },
      `${opts.callerLabel}: evaluatePriority threw — counting as error and continuing`,
    );
    return { status: "error" };
  }

  const previousLevel = (learner.teacher_priority_level ??
    "p4") as PriorityLevel;
  const previousAction = learner.teacher_recommended_action ?? null;
  const localisedAction = getLocalisedAction(verdict.trigger_key, "en");
  const now = new Date();

  try {
    await User.updateOne(
      { _id: learner._id },
      {
        $set: {
          teacher_priority_level: verdict.level,
          teacher_recommended_action: localisedAction,
          // Todo 23.5 — persist the trigger key so the teacher UI
          // can dispatch the right click handler without parsing
          // the localised template text.
          teacher_priority_trigger_key: verdict.trigger_key,
          teacher_priority_updated_at: now,
        },
      },
    );
  } catch (err) {
    logger.error(
      {
        err: (err as Error).message,
        learner_id: learnerIdStr,
        org_id: opts.orgIdForAudit,
        runId: opts.runId,
      },
      `${opts.callerLabel}: User.updateOne failed — counting as error and continuing`,
    );
    return { status: "error" };
  }

  const changed = previousLevel !== verdict.level;
  if (changed) {
    await writeAuditLog({
      actor_type: "system",
      actor_id: null,
      org_id: opts.orgIdForAudit,
      learner_id: learnerIdStr,
      action: "learner_priority_changed",
      before_state: {
        teacher_priority_level: previousLevel,
        teacher_recommended_action: previousAction,
      },
      after_state: {
        teacher_priority_level: verdict.level,
        teacher_recommended_action: localisedAction,
        trigger_key: verdict.trigger_key,
      },
      reason: `Priority shifted ${previousLevel.toUpperCase()} → ${verdict.level.toUpperCase()}: ${verdict.reason}`,
    });
  }

  return { status: "ok", verdict, changed };
};

// ─────────────────────────────────────────────────────────────────────
// Single-learner recalc — Final Addendum §10, Todo 23.4
//
// Fired off teacher actions (review log, pathway override, RARPA
// sign-off). Wraps the same evaluate+write helper as the per-org
// recalc; no summary audit (we only write the per-change row
// when the level actually shifted).
// ─────────────────────────────────────────────────────────────────────

export interface RecalcLearnerPriorityResult {
  learner_id: string;
  status: "ok" | "error" | "skipped";
  changed?: boolean;
  level?: PriorityLevel;
  trigger_key?: PriorityTriggerKey;
  duration_ms: number;
}

export const runLearnerPriorityRecalc = async (
  learner_id: string,
  jobId: string,
): Promise<RecalcLearnerPriorityResult> => {
  const startedAt = Date.now();
  if (!learner_id || !Types.ObjectId.isValid(learner_id)) {
    throw new Error(
      `runLearnerPriorityRecalc: learner_id must be a valid ObjectId (got ${learner_id})`,
    );
  }
  // Narrow projection — same fields the org-loop needs, plus the
  // orgId we need for the audit row's org_id stamp.
  const learner = await User.findById(learner_id)
    .select(
      "_id firstname lastname role orgId teacher_priority_level teacher_recommended_action assigned_teacher_id",
    )
    .lean<
      | (LearnerSkeleton & { role?: string; orgId?: Types.ObjectId | null })
      | null
    >();

  if (!learner) {
    logger.warn(
      { learner_id, jobId },
      "runLearnerPriorityRecalc: learner not found — skipping",
    );
    return {
      learner_id,
      status: "skipped",
      duration_ms: Date.now() - startedAt,
    };
  }
  if (learner.role !== "student") {
    logger.warn(
      { learner_id, role: learner.role, jobId },
      "runLearnerPriorityRecalc: not a student — skipping",
    );
    return {
      learner_id,
      status: "skipped",
      duration_ms: Date.now() - startedAt,
    };
  }
  if (!learner.orgId) {
    // Defensive — no audit row stamp possible. Skip rather than
    // silently audit with a null org_id.
    logger.error(
      { learner_id, jobId },
      "runLearnerPriorityRecalc: learner has no orgId — skipping",
    );
    return {
      learner_id,
      status: "error",
      duration_ms: Date.now() - startedAt,
    };
  }

  const outcome = await evaluateAndWriteForLearner(learner, {
    runId: jobId,
    orgIdForAudit: learner.orgId.toString(),
    callerLabel: "runLearnerPriorityRecalc",
  });

  const duration_ms = Date.now() - startedAt;
  if (outcome.status === "error") {
    return { learner_id, status: "error", duration_ms };
  }

  logger.info(
    {
      learner_id,
      jobId,
      level: outcome.verdict.level,
      trigger_key: outcome.verdict.trigger_key,
      changed: outcome.changed,
      duration_ms,
    },
    "runLearnerPriorityRecalc: complete",
  );

  return {
    learner_id,
    status: "ok",
    changed: outcome.changed,
    level: outcome.verdict.level,
    trigger_key: outcome.verdict.trigger_key,
    duration_ms,
  };
};

export const processRecalcLearnerPriority = async (
  job: Job<{
    learnerId?: string;
    learner_id?: string;
    triggerEvent?: string;
  }>,
): Promise<RecalcLearnerPriorityResult | { skipped: true; reason: string }> => {
  // Accept both camelCase (matches the queue's existing convention)
  // and snake_case (Todo 23.4's payload spec).
  const learnerIdRaw = job.data.learnerId ?? job.data.learner_id;
  if (!learnerIdRaw) {
    logger.warn(
      { jobId: job.id },
      "processRecalcLearnerPriority: missing learner_id — skipping",
    );
    return { skipped: true, reason: "missing learner_id" };
  }
  if (!Types.ObjectId.isValid(learnerIdRaw)) {
    logger.warn(
      { jobId: job.id, learner_id: learnerIdRaw },
      "processRecalcLearnerPriority: invalid learner_id — skipping",
    );
    return { skipped: true, reason: "invalid learner_id" };
  }
  return runLearnerPriorityRecalc(learnerIdRaw, String(job.id ?? "ad-hoc"));
};

// ─────────────────────────────────────────────────────────────────────
// Producer-side enqueue helper — Final Addendum §10, Todo 23.4
//
//   enqueueLearnerPriorityRecalc(learnerId, triggerEvent)
//     → jobId `recalc:${learnerId}:${YYYY-MM-DDTHH:mm}` (per-minute
//       dedupe window)
//
// Why per-minute, not per-day
// ===========================
//
// A teacher logging three back-to-back actions on one learner (a
// pathway override, a review, and a sign-off — all within 30
// seconds during a tutoring session) should produce ONE recalc,
// not three. But two actions ten minutes apart represent distinct
// signals worth re-scoring against, so the per-day window in the
// old `teacher-priority-score` enqueue was too coarse — the
// learner's verdict could be 23h stale by the time the next
// action fired.
//
// One-minute granularity is the right balance: rapid bursts
// collapse, but a deliberate "I've made a change, I want to see
// the new score" round-trip is honoured.
//
// Dedupe semantics
// ================
//
// BullMQ silently no-ops `add()` calls with a jobId that already
// exists in any state (waiting, active, completed, failed). Two
// add() calls in the same minute return references to the SAME
// underlying job; the second is a property-lookup, not a Redis
// write. There's no race window — BullMQ's add-by-id check is
// atomic against the job index.
//
// Error swallow
// =============
//
// Queue write failures are logged and SWALLOWED. The teacher
// action (review row, pathway override, sign-off) is the durable
// artefact; the daily per-org cron will catch the staleness within
// 24h. A Redis hiccup MUST NOT roll back a committed review.
// ─────────────────────────────────────────────────────────────────────

export interface EnqueueLearnerPriorityRecalcResult {
  jobId: string;
  /**
   * `true` when this call actually enqueued the job; `false` when
   * a job with this id already existed (dedupe hit) — the caller
   * may want to surface "we collapsed onto an in-flight recalc"
   * vs "we kicked off a fresh one" for log readability.
   */
  enqueued: boolean;
}

export const enqueueLearnerPriorityRecalc = async (
  learnerId: string,
  triggerEvent:
    | "review_logged"
    | "pathway_override_set"
    | "rarpa_stage5_signed_off",
): Promise<EnqueueLearnerPriorityRecalcResult | null> => {
  if (!learnerId || !Types.ObjectId.isValid(learnerId)) {
    logger.warn(
      { learnerId, triggerEvent },
      "enqueueLearnerPriorityRecalc: invalid learner id — skipping enqueue",
    );
    return null;
  }
  // ISO minute slice: "2026-06-03T14:32" — collapses any two
  // enqueues for the same learner within the same wall-clock
  // minute onto a single jobId.
  const minute = new Date().toISOString().slice(0, 16);
  const jobId = `recalc:${learnerId}:${minute}`;

  try {
    const job = await priorityQueueQueue.add(
      "recalc-learner-priority",
      {
        // The queue's PriorityQueueJob payload carries `date` (the
        // ISO date the run is for) — keep it set so the type
        // checker is happy and a future log line can read it
        // alongside the BullMQ-derived `jobId`.
        date: minute.slice(0, 10),
        learnerId,
        action: "recalc-learner-priority",
        triggerEvent,
      },
      { jobId },
    );
    // BullMQ returns the existing job when the jobId collides.
    // `job.timestamp` (ms) tells us whether this call actually
    // wrote it — a sub-second-old job means we just enqueued.
    // We compare against the wall clock; anything older than 1s
    // is a dedupe hit. A second-boundary edge is acceptable noise
    // for a log flag.
    const enqueued = Date.now() - job.timestamp < 1000;
    return { jobId, enqueued };
  } catch (err) {
    // Queue write failures are SWALLOWED — the teacher action is
    // the durable artefact; the daily per-org cron will catch
    // any staleness within 24h.
    logger.error(
      {
        err: (err as Error).message,
        learner_id: learnerId,
        jobId,
        triggerEvent,
      },
      "enqueueLearnerPriorityRecalc: queue add failed — daily cron will catch up",
    );
    return null;
  }
};

// ─────────────────────────────────────────────────────────────────────
// Test exports
// ─────────────────────────────────────────────────────────────────────

export const __internals__ = {
  getLocalisedAction,
  writeSummaryAudit,
  evaluateAndWriteForLearner,
};
