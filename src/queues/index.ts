import { Queue, JobsOptions, ConnectionOptions } from "bullmq";
import { createBullmqConnection, isRedisAvailable } from "../lib/redis";
import logger from "../config/logger";

/**
 * BullMQ queues for Project Silk.
 *
 * One Queue per concern. All queues share the singleton ioredis connection
 * from src/lib/redis.ts — never construct another Redis client.
 *
 * Priority semantics (BullMQ priority is per-job, lower = higher priority):
 *   - HIGH (priority 1)     — block on this; user is waiting on the outcome
 *   - STANDARD (priority 5) — best effort within minutes
 *   - LOW (priority 10)     — background, can wait hours/days
 *
 * Priority only affects ordering *within* a single queue. Across queues, the
 * effective priority is set by worker concurrency and the number of worker
 * processes assigned. See src/workers/index.ts.
 *
 * Job names within each queue are free-form strings — used for logging and
 * for filtering in the BullMQ UI. Add new job names freely.
 */

const PRIORITY_HIGH = 1;
const PRIORITY_STANDARD = 5;
const PRIORITY_LOW = 10;

/**
 * Standard retry + cleanup defaults applied to every queue.
 *
 * - 3 attempts total (initial + 2 retries) with backoffs 5s, 30s, 120s
 *   handled by the custom backoffStrategy registered on each worker.
 * - removeOnComplete: keep 1000 most-recent successful jobs for audit;
 *   older ones get evicted automatically.
 * - removeOnFail: keep 5000 failed jobs — combined with the failed_jobs
 *   MongoDB collection this gives both BullMQ-native and queryable history.
 */
const baseDefaults: JobsOptions = {
  attempts: 3,
  backoff: { type: "custom" },
  removeOnComplete: { count: 1000 },
  removeOnFail: { count: 5000 },
};

// One dedicated ioredis connection shared by all 8 Queue producers. Queues
// (unlike workers) can safely share a connection because they don't issue
// blocking commands. Workers get their own per createBaseWorker.
//
// Soft-fail path: when REDIS_URL isn't set (dev iteration without an
// Upstash instance), `createBullmqConnection` returns null. We replace
// every exported `Queue<T>` with a no-op stub via `stubQueueOnNull` —
// callers' `.add()` calls log + drop instead of crashing.
const rawConnection = createBullmqConnection();
const connection = rawConnection as unknown as ConnectionOptions;

/**
 * Build a real Queue when Redis is configured; a no-op stub when it
 * isn't. The stub shares the public Queue surface that producer code
 * actually uses (`.add()`, `.name`, `.close()`) — anything else throws
 * a clear message rather than silently misbehaving.
 *
 * Why a stub instead of letting `.add()` fail at runtime:
 *   • Dev experience — `npm run dev` without Redis still serves the
 *     API. Frontend work doesn't block on Upstash being up.
 *   • Cron pipelines — daily fan-out jobs are idempotent; a missed
 *     run catches up on the next day. Better than a 500 cascade.
 */
// Throttle the "ignored — Redis degraded" log line per queue. Without this,
// a code path that fans out N jobs while Redis is down emits N identical
// warnings. 30s window matches the redis.ts DEGRADE_COOLDOWN_MS.
const _lastDropLogAt = new Map<string, number>();
const DROP_LOG_THROTTLE_MS = 30_000;

const logQueueDrop = (queue: string, jobName: string, count = 1): void => {
  const now = Date.now();
  const last = _lastDropLogAt.get(queue) ?? 0;
  if (now - last > DROP_LOG_THROTTLE_MS) {
    logger.warn(
      { queue, jobName, droppedSinceWarn: count },
      "Queue enqueue ignored (Redis degraded). Job(s) dropped. " +
        "Further drops on this queue suppressed for 30s.",
    );
    _lastDropLogAt.set(queue, now);
  }
};

const makeQueue = <T>(
  name: string,
  opts: { defaultJobOptions: JobsOptions },
) => {
  if (!rawConnection) {
    // REDIS_URL not set at boot — return the no-op stub directly. Stable for
    // local dev without an Upstash instance.
    const stub = {
      name,
      add: async (jobName: string, _data: T, _options?: JobsOptions) => {
        logQueueDrop(name, jobName);
        return { id: null, name: jobName, data: _data } as unknown as never;
      },
      addBulk: async (jobs: { name: string; data: T }[]) => {
        logQueueDrop(name, "(bulk)", jobs.length);
        return [] as unknown as never;
      },
      close: async () => undefined,
      getJob: async () => null,
      getJobs: async () => [],
      getJobCounts: async () => ({
        waiting: 0,
        active: 0,
        completed: 0,
        failed: 0,
        delayed: 0,
        paused: 0,
      }),
    };
    return stub as unknown as Queue<T>;
  }

  // Redis IS configured at boot, so we build a real Queue. But at runtime
  // Upstash can drop into a degraded state (quota exhausted, OOM, LOADING)
  // — in which case isRedisAvailable() flips false and we want .add() /
  // .addBulk() to fall through to the same no-op path the boot-stub uses
  // instead of throwing every command into the void.
  //
  // We intercept by replacing the two enqueue methods on the real Queue
  // instance. The original implementations are bound and called only when
  // Redis is healthy; otherwise we log (throttled) and return a stub job.
  const realQueue = new Queue<T>(name, { connection, ...opts });
  const realAdd = realQueue.add.bind(realQueue);
  const realAddBulk = realQueue.addBulk.bind(realQueue);

  // The casts on the next two assignments and on `realAdd` / `realAddBulk`
  // arguments below: BullMQ's Queue.add / addBulk are generically typed with
  // `ExtractNameType<T, string>` to enforce job-name narrowing in stricter
  // setups. Our queue payloads use plain string names, so we widen via
  // `unknown as` at the boundary. Internal types are unaffected.
  realQueue.add = (async (jobName: string, data: T, options?: JobsOptions) => {
    if (!isRedisAvailable()) {
      logQueueDrop(name, jobName);
      return { id: null, name: jobName, data } as unknown as never;
    }
    return realAdd(jobName as never, data as never, options);
  }) as unknown as Queue<T>["add"];

  realQueue.addBulk = (async (
    jobs: Array<{ name: string; data: T; opts?: JobsOptions }>,
  ) => {
    if (!isRedisAvailable()) {
      logQueueDrop(name, "(bulk)", jobs.length);
      return [] as unknown as never;
    }
    return realAddBulk(jobs as unknown as Parameters<typeof realAddBulk>[0]);
  }) as unknown as Queue<T>["addBulk"];

  return realQueue;
};

// ── Job payload types ───────────────────────────────────────────────────
// Payload shapes are the contract between producers (services that enqueue)
// and consumers (workers that process). Keep them narrow; if a payload needs
// to balloon, that's a sign the work belongs in multiple jobs.

export interface EsolSessionJob {
  sessionId: string;
  learnerId: string;
  orgId: string;
  /**
   * Lifecycle step. `process_turn` is the per-turn AI inference and grading;
   * `capture_evidence` writes the post-session evidence packet; `update_vocab`
   * advances the vocabulary ledger.
   */
  action: "process_turn" | "capture_evidence" | "update_vocab";
  // Action-specific payload. Untyped here to keep the queue agnostic;
  // the processor narrows by `action`.
  payload?: Record<string, unknown>;
}

/**
 * Per-learner RARPA stage-compile job (the original `rarpa-evidence`
 * payload). Used by Phase 11 to advance a single learner through a
 * RARPA stage on the back of a session completion / level progression /
 * manual recompile trigger.
 */
export interface RarpaStageCompileJob {
  kind: "stage_compile";
  learnerId: string;
  orgId: string;
  /** RARPA stage being compiled or advanced (1–5). */
  stage: 1 | 2 | 3 | 4 | 5;
  triggerEvent: "session_completed" | "level_progression" | "manual_recompile";
}

/**
 * Consolidated evidence-report job — brief Function 14 To-Do 4.
 *
 * Org-wide, period-scoped. The route layer computes the idempotency
 * key (sha256(org_id + period_start + period_end)) and passes it
 * through as `reportId`; the worker echoes it back so the status
 * endpoint can surface the download URL deterministically.
 */
export interface RarpaEvidenceReportJob {
  kind: "evidence_report";
  orgId: string;
  /** ISO YYYY-MM-DD. Bounds the cohort window. */
  periodStart: string;
  periodEnd: string;
  requestedBy: string;
  /** sha256(org_id + period_start + period_end). Deterministic id used both
   *  as the IdempotencyKey lock and as the PDF cache filename. */
  reportId: string;
}

/**
 * Stage 5 AI tutor summary — brief Function 17.
 *
 * Enqueued by triggerStage5Review after a level-change confirmation.
 * The worker loads the Stage5Review by id, aggregates the learner's
 * just-completed-level sessions, calls Gemini, writes the structured
 * summary back to `ai_tutor_summary`, and notifies the org admin(s).
 *
 * Minimal payload — orgId / learnerId are derived from the
 * Stage5Review row at worker time. Keeping the payload narrow means
 * the worker can never be tricked by a stale enqueue snapshot
 * (e.g. learner moved orgs after the job was enqueued).
 */
export interface RarpaStage5SummaryJob {
  kind: "stage5_summary";
  stage5_review_id: string;
}

/**
 * Discriminated union on `kind`. Old enqueue sites must add the
 * `kind: "stage_compile"` literal (back-compat handled by the
 * processor, which defaults missing kind to "stage_compile").
 */
export type RarpaEvidenceJob =
  | RarpaStageCompileJob
  | RarpaEvidenceReportJob
  | RarpaStage5SummaryJob;

export interface IlrExportJob {
  orgId: string;
  /** Academic year code (e.g. "2025/26") — picks the compliance config. */
  academicYear: string;
  /** ISO-8601 dates. Defines the ILR claim window. */
  periodStart: string;
  periodEnd: string;
  requestedBy: string;
  /** The idempotency key — computed by the caller; the worker echoes it back as export_id. */
  exportId: string;
  includeWarnings?: boolean;
}

/**
 * Compliance-validation job — Phase 21 + Final Addendum §7.
 *
 * Two flavours, discriminated on `target`:
 *
 *   - `target: "ilr" | "rarpa"` — references an existing artefact
 *     (export_id) that's already been built and needs green-lighting
 *     before its downstream push.
 *   - `target: "mis"` — references one or many ULNs on an org. The
 *     worker builds the MISRecord(s) and validates each against the
 *     active ComplianceConfig. Used as a standalone pre-check entry
 *     point; the mis-push worker itself ALSO runs validation inline
 *     so a direct push doesn't bypass the gate.
 */
export interface ComplianceValidationJob {
  target: "ilr" | "rarpa" | "mis";
  orgId: string;
  /** Set when validating an existing exported artefact (ilr / rarpa). */
  exportId?: string;
  /** Set when validating MIS records directly (single ULN). */
  uln?: string;
  /** Set when validating MIS records directly (batch). */
  ulns?: string[];
}

/**
 * MIS push job — Final Addendum §7.
 *
 * Per-learner pushes via the per-vendor adapter registered in
 * `services/mis/AdapterFactory.ts`. Discriminated on `kind`:
 *
 *   - `push-learner` — single ULN, one adapter.pushLearner() call.
 *   - `push-batch`   — many ULNs, one adapter.pushBatch() call
 *                      (chunked at the adapter layer per vendor cap).
 *
 * The IdempotencyKey wrapping the job uses:
 *   - single: sha256(`${org_id}|${uln}|mis_push`)
 *   - batch:  sha256(`${org_id}|${sorted_ulns_joined}|mis_push_batch`)
 *
 * Sorting the batch ULNs before hashing keeps two callers that
 * happen to enqueue the same set in different orders idempotent
 * against each other.
 */
export type MisPushJob =
  | {
      kind: "push-learner";
      org_id: string;
      uln: string;
      /** Authenticated caller — for audit log + admin notification routing. */
      requested_by?: string;
    }
  | {
      kind: "push-batch";
      org_id: string;
      ulns: string[];
      requested_by?: string;
    };

export interface PriorityQueueJob {
  /** ISO date the scoring run is for. */
  date: string;
  orgId?: string; // optional scope; absent = platform-wide
  /**
   * Per-learner check trigger. When set, the consumer (Phase 12) runs
   * a level-progression check for ONE learner instead of the
   * platform-wide batch. Used by /api/esol/session/end to defer the
   * check off the request path.
   */
  learnerId?: string;
  /**
   * Why the job was enqueued — read by the consumer to branch.
   * `review_logged` (Final Addendum §9, Todo 22.5) lets the Phase 23
   * scoring algorithm weight the recency signal differently when a
   * teacher has just reviewed the learner vs a passive session end.
   * `pathway_override_set` and `rarpa_stage5_signed_off` (Todo 23.4)
   * carry the same role for the other two teacher-action triggers.
   */
  triggerEvent?:
    | "scheduled"
    | "session_completed"
    | "manual"
    | "review_logged"
    | "pathway_override_set"
    | "rarpa_stage5_signed_off";
  /**
   * Function 11 — what the job is FOR. The priority-queue is shared
   * between several daily jobs; the processor dispatches on `action`.
   *   - "check-progression"      → daily cron fans out per-org
   *                                progression sweep
   *   - "teacher-priority-score" → legacy default; teacher-prep scoring
   *                                run (Phase 23). Absent action falls
   *                                back to this for back-compat.
   *   - "recalc-org-priorities"  → Final Addendum §10, Todo 23.3.
   *                                Per-org teacher-priority recalc:
   *                                evaluatePriority for every learner,
   *                                write back the verdict, audit any
   *                                level changes + a summary.
   *   - "recalc-learner-priority" → Final Addendum §10, Todo 23.4.
   *                                Single-learner recalc fired off
   *                                teacher actions (review log,
   *                                pathway override, RARPA sign-off).
   *                                Dedupe via per-minute jobId so
   *                                rapid actions collapse onto one
   *                                recalc.
   */
  action?:
    | "check-progression"
    | "teacher-priority-score"
    | "recalc-org-priorities"
    | "recalc-learner-priority";
}

/**
 * Delta-sync job — Final Addendum §7.
 *
 * One job per org per cron firing. The cron handler fans out at
 * 04:00 UTC daily; each job pulls per-learner status from the
 * org's MIS via `adapter.pullLearnerStatus(uln)` and records
 * discrepancies against Project Silk's view.
 *
 * `orgId` is required (per-org enqueueing — no platform-wide
 * sweep). `date` is the ISO date the cron fired (for the audit
 * trail). `windowHours` is reserved for future per-org cadence
 * overrides; default 24h matches the daily cron.
 */
export interface DeltaSyncJob {
  date: string;
  orgId: string;
  windowHours?: number;
}

export interface NotificationJob {
  channel: "email" | "sms" | "in_app";
  recipientId: string;
  /**
   * Notification type — drives template selection. Examples:
   *  - safeguarding_alert
   *  - teacher_message
   *  - submission_confirmation
   *  - reengagement_email
   *  - admin_job_failure  (used by workers when a job exhausts retries)
   */
  type: string;
  payload: Record<string, unknown>;
}

/**
 * Safeguarding-alert email payload — brief Function 10.
 *
 * The DELIBERATELY minimal shape: category + org_id only. The worker
 * looks up the org by id (one Mongo round-trip) so the email can show
 * the org name without ever carrying learner identity or message
 * content through the queue. If Redis ever leaks, the worst this
 * payload reveals is "org X had a safeguarding event of category Y at
 * time T" — no PII, no disclosure content.
 *
 * `alert_id` lets the worker stamp `notificationSentAt` back on the
 * SafeguardingAlert document. `alert_created_at` is the dispatch-
 * latency clock start — the p95 < 5s SLA in the brief is measured from
 * SafeguardingAlert.create to email-sent.
 *
 * Enqueued via `notificationsQueue.add("safeguarding-alert", payload)`;
 * dispatched by name inside processNotifications.
 */
export interface SafeguardingAlertEmailJob {
  category: string;
  org_id: string;
  alert_id: string;
  /** ISO timestamp of SafeguardingAlert.create — used to compute dispatch latency. */
  alert_created_at: string;
}

/**
 * cache-refresh — long-running cache load jobs.
 *
 * Two job names supported by the processor:
 *   - "postcode-load"  → loads the DfE ASF postcode dataset into Redis
 *   - "fala-refresh"   → reloads the FALA LearnAimRef whitelist in Redis
 *
 * Long lockDuration (10 min by default, see LARGE_DATASET_TIMEOUT env var)
 * so the postcode load doesn't lose its lock mid-pipeline.
 */
export interface CacheRefreshJob {
  task: "postcode-load" | "fala-refresh";
  academicYear: string;
  source?: string; // optional override for postcode dataset path/URL
}

// ── Queue exports ───────────────────────────────────────────────────────

export const esolSessionQueue = makeQueue<EsolSessionJob>("esol-session", {
  defaultJobOptions: { ...baseDefaults, priority: PRIORITY_HIGH },
});

export const rarpaEvidenceQueue = makeQueue<RarpaEvidenceJob>(
  "rarpa-evidence",
  {
    defaultJobOptions: { ...baseDefaults, priority: PRIORITY_STANDARD },
  },
);

export const ilrExportQueue = makeQueue<IlrExportJob>("ilr-export", {
  defaultJobOptions: { ...baseDefaults, priority: PRIORITY_STANDARD },
});

export const complianceValidationQueue = makeQueue<ComplianceValidationJob>(
  "compliance-validation",
  {
    defaultJobOptions: { ...baseDefaults, priority: PRIORITY_HIGH },
  },
);

export const misPushQueue = makeQueue<MisPushJob>("mis-push", {
  defaultJobOptions: { ...baseDefaults, priority: PRIORITY_STANDARD },
});

export const priorityQueueQueue = makeQueue<PriorityQueueJob>(
  "priority-queue",
  {
    defaultJobOptions: { ...baseDefaults, priority: PRIORITY_LOW },
  },
);

export const deltaSyncQueue = makeQueue<DeltaSyncJob>("delta-sync", {
  defaultJobOptions: { ...baseDefaults, priority: PRIORITY_LOW },
});

/**
 * Notifications queue accepts two payload shapes (discriminated by job name):
 *   - "safeguarding-alert" → SafeguardingAlertEmailJob (minimal, no PII)
 *   - everything else      → NotificationJob (generic email/sms/in-app)
 *
 * The processor narrows by `job.name`. New typed payloads should be added
 * to this union rather than smuggled inside NotificationJob.payload.
 */
export type NotificationsQueuePayload =
  | NotificationJob
  | SafeguardingAlertEmailJob;

export const notificationsQueue = makeQueue<NotificationsQueuePayload>(
  "notifications",
  {
    defaultJobOptions: { ...baseDefaults, priority: PRIORITY_HIGH },
  },
);

export const cacheRefreshQueue = makeQueue<CacheRefreshJob>("cache-refresh", {
  defaultJobOptions: {
    ...baseDefaults,
    priority: PRIORITY_LOW,
    // Postcode load can take ~10 min on the full DfE file. Only retry once
    // to avoid hammering Redis after a real failure.
    attempts: 2,
  },
});

/**
 * Map of queue name → Queue instance. Used by createBaseWorker to look up
 * the right queue for the admin-failure notification fan-out, and for any
 * future "graceful shutdown of all queues" logic.
 */
export const allQueues = {
  "esol-session": esolSessionQueue,
  "rarpa-evidence": rarpaEvidenceQueue,
  "ilr-export": ilrExportQueue,
  "compliance-validation": complianceValidationQueue,
  "mis-push": misPushQueue,
  "priority-queue": priorityQueueQueue,
  "delta-sync": deltaSyncQueue,
  notifications: notificationsQueue,
  "cache-refresh": cacheRefreshQueue,
} as const;

export type QueueName = keyof typeof allQueues;
