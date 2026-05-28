import { Queue, JobsOptions, ConnectionOptions } from "bullmq";
import { createBullmqConnection } from "../lib/redis";

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
const connection = createBullmqConnection() as unknown as ConnectionOptions;

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

export interface RarpaEvidenceJob {
  learnerId: string;
  orgId: string;
  /** RARPA stage being compiled or advanced (1–5). */
  stage: 1 | 2 | 3 | 4 | 5;
  triggerEvent: "session_completed" | "level_progression" | "manual_recompile";
}

export interface IlrExportJob {
  orgId: string;
  /** ISO-8601 dates. Defines the ILR claim window. */
  periodStart: string;
  periodEnd: string;
  requestedBy: string;
  includeWarnings?: boolean;
}

export interface ComplianceValidationJob {
  /** Reference to the artefact being green-lit before push. */
  exportId: string;
  target: "ilr" | "rarpa" | "mis";
  orgId: string;
}

export interface MisPushJob {
  exportId: string;
  misProvider: "ProSolution" | "Maytas" | "EBS";
  orgId: string;
  /** Where the validated artefact lives (e.g. S3 key, file path, blob URL). */
  artefactRef: string;
}

export interface PriorityQueueJob {
  /** ISO date the scoring run is for. */
  date: string;
  orgId?: string; // optional scope; absent = platform-wide
}

export interface DeltaSyncJob {
  date: string;
  orgId?: string;
  /** Optional override for the lookback window in hours; default 24. */
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

export const esolSessionQueue = new Queue<EsolSessionJob>("esol-session", {
  connection,
  defaultJobOptions: { ...baseDefaults, priority: PRIORITY_HIGH },
});

export const rarpaEvidenceQueue = new Queue<RarpaEvidenceJob>("rarpa-evidence", {
  connection,
  defaultJobOptions: { ...baseDefaults, priority: PRIORITY_STANDARD },
});

export const ilrExportQueue = new Queue<IlrExportJob>("ilr-export", {
  connection,
  defaultJobOptions: { ...baseDefaults, priority: PRIORITY_STANDARD },
});

export const complianceValidationQueue = new Queue<ComplianceValidationJob>(
  "compliance-validation",
  {
    connection,
    defaultJobOptions: { ...baseDefaults, priority: PRIORITY_HIGH },
  }
);

export const misPushQueue = new Queue<MisPushJob>("mis-push", {
  connection,
  defaultJobOptions: { ...baseDefaults, priority: PRIORITY_STANDARD },
});

export const priorityQueueQueue = new Queue<PriorityQueueJob>("priority-queue", {
  connection,
  defaultJobOptions: { ...baseDefaults, priority: PRIORITY_LOW },
});

export const deltaSyncQueue = new Queue<DeltaSyncJob>("delta-sync", {
  connection,
  defaultJobOptions: { ...baseDefaults, priority: PRIORITY_LOW },
});

export const notificationsQueue = new Queue<NotificationJob>("notifications", {
  connection,
  defaultJobOptions: { ...baseDefaults, priority: PRIORITY_HIGH },
});

export const cacheRefreshQueue = new Queue<CacheRefreshJob>("cache-refresh", {
  connection,
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
