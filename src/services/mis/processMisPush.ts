/**
 * MIS push worker — Phase 21, Final Addendum §7.
 *
 *   processMisPush(job: Job<MisPushJob>) — wired via
 *   queueProcessors/index.ts to the `mis-push` BullMQ queue.
 *
 * Pipeline
 * ========
 *
 *   1. Wrap the entire job in `IdempotencyService.check` with the
 *      brief's specified keys:
 *        - single: sha256(`${org_id}|${uln}|mis_push`)
 *        - batch:  sha256(`${org_id}|${sorted_ulns_joined}|mis_push_batch`)
 *      A duplicate enqueue within the 90-day TTL replays the
 *      cached result without re-pushing.
 *
 *   2. Resolve the adapter via `AdapterFactory.getAdapter(org_id)`.
 *      `MISNotConfiguredError` flows back as `status: "skipped"` —
 *      not a job failure.
 *
 *   3. Build the `MISRecord`(s) via `buildMisRecord`.
 *
 *   4. **Validate inline** via `validateMisRecord` (defence-in-depth
 *      over the standalone `compliance-validation` queue). Held
 *      records get an `mis_push_held` AuditLog row and are SKIPPED;
 *      the push continues with valid records only.
 *
 *   5. Call `adapter.pushLearner` / `adapter.pushBatch`. Each
 *      adapter handles its own 5xx-retry-once policy internally.
 *
 *   6. Per-record AuditLog: `mis_push_completed` on success,
 *      `mis_push_held` on validation-only failure, plain
 *      `mis_push_completed` with `success: false` on 4xx (the row
 *      is the audit trail of the attempt; the result envelope
 *      carries the error string for the admin to see).
 *
 *   7. **4xx**: don't retry, mark a FailedJob row, notify the
 *      Amber admin via the existing notifications queue.
 *      Implemented via the adapter returning `{success: false}`
 *      (no throw) — the worker reads `success` per record and
 *      writes a FailedJob row through the standard worker
 *      base-class path on terminal failure.
 *
 *   8. **5xx**: bubble. `MISServerError` thrown by the adapter
 *      propagates out of `processMisPush`; BullMQ's retry policy
 *      (3 attempts with 5s/30s/120s backoff) handles it.
 *
 *   9. **Auth** (`MISAuthError`): bubble. The whole batch fails
 *      because subsequent calls with the same credentials would
 *      also 401. Logged + notified.
 */

import { Job } from "bullmq";
import { createHash } from "crypto";
import { Types } from "mongoose";
import FailedJob from "../../models/FailedJob";
import logger from "../../config/logger";
import IdempotencyService from "../idempotency.service";
import { notificationsQueue } from "../../queues";
import { writeAuditLog } from "../auditLog.service";
import { getAdapter } from "./AdapterFactory";
import { buildMisRecord } from "./buildMisRecord";
import { validateMisRecord, ValidationResult } from "./validateMisRecord";
import {
  IMISAdapter,
  MISAuthError,
  MISNotConfiguredError,
  MISPushResult,
  MISRecord,
  MISServerError,
} from "./types";
import type { MisPushJob } from "../../queues";

// ─────────────────────────────────────────────────────────────────────
// Result envelope returned to BullMQ via the job return value
// ─────────────────────────────────────────────────────────────────────

export interface MisPushJobResult {
  kind: "push-learner" | "push-batch";
  org_id: string;
  /** Total ULNs the job touched (including held + failed). */
  total: number;
  /** Held by validation. */
  held: number;
  /** Pushed and accepted by the MIS. */
  pushed: number;
  /** Pushed but rejected by the MIS (4xx — terminal). */
  failed: number;
  /** Skipped because the org has no MIS configured. */
  skipped: boolean;
  /** Per-ULN summary for the failed-jobs dashboard. */
  per_record: Array<{
    uln: string;
    status: "pushed" | "held" | "failed" | "build_error";
    provider_record_id?: string;
    error?: string;
    held_reasons?: string[];
  }>;
}

// ─────────────────────────────────────────────────────────────────────
// Idempotency-key construction (brief Function 17 §7 spec)
// ─────────────────────────────────────────────────────────────────────

const singleIdempotencyKey = (org_id: string, uln: string): string =>
  createHash("sha256")
    .update(`${org_id}|${uln}|mis_push`)
    .digest("hex");

const batchIdempotencyKey = (org_id: string, ulns: string[]): string => {
  // Sort BEFORE hashing so two callers that happen to enqueue the
  // same set in different orders are idempotent against each other.
  const sorted = [...ulns].sort();
  return createHash("sha256")
    .update(`${org_id}|${sorted.join(",")}|mis_push_batch`)
    .digest("hex");
};

// ─────────────────────────────────────────────────────────────────────
// Build + validate one record. Returns either the validated record
// or a held envelope ready for the AuditLog.
// ─────────────────────────────────────────────────────────────────────

type BuiltOrHeld =
  | { kind: "ok"; record: MISRecord; validation: ValidationResult }
  | { kind: "held"; uln: string; reasons: string[]; compliance_config_version: number | null }
  | { kind: "build_error"; uln: string; error: string };

const buildAndValidate = async (
  org_id: string,
  uln: string,
): Promise<BuiltOrHeld> => {
  let record: MISRecord;
  try {
    record = await buildMisRecord(org_id, uln);
  } catch (err) {
    return {
      kind: "build_error",
      uln,
      error: (err as Error).message,
    };
  }
  const validation = validateMisRecord(record);
  if (!validation.valid) {
    return {
      kind: "held",
      uln,
      reasons: validation.reasons,
      compliance_config_version: validation.compliance_config_version,
    };
  }
  return { kind: "ok", record, validation };
};

// ─────────────────────────────────────────────────────────────────────
// AuditLog helpers per outcome
// ─────────────────────────────────────────────────────────────────────

const auditHeld = async (input: {
  org_id: string;
  uln: string;
  reasons: string[];
  config_version: number | null;
  caller_id: string | null;
}) =>
  writeAuditLog({
    actor_type: "amber_admin",
    actor_id: input.caller_id,
    org_id: input.org_id,
    learner_id: null,
    action: "mis_push_held",
    before_state: null,
    after_state: {
      uln: input.uln,
      reasons: input.reasons,
    },
    reason: `MIS push held — ${input.reasons.length} validation failure(s) on ULN ${input.uln}.`,
    compliance_config_version: input.config_version,
  });

const auditCompleted = async (input: {
  org_id: string;
  uln: string;
  result: MISPushResult;
  config_version: number | null;
  provider: string;
  caller_id: string | null;
}) =>
  writeAuditLog({
    actor_type: "amber_admin",
    actor_id: input.caller_id,
    org_id: input.org_id,
    learner_id: null,
    action: "mis_push_completed",
    before_state: null,
    after_state: {
      uln: input.uln,
      provider: input.provider,
      success: input.result.success,
      provider_record_id: input.result.provider_record_id ?? null,
      error: input.result.error ?? null,
      warnings: input.result.warnings ?? [],
    },
    reason: input.result.success
      ? `MIS push completed — ${input.provider} accepted ULN ${input.uln} as ${input.result.provider_record_id}.`
      : `MIS push completed but ${input.provider} rejected ULN ${input.uln}: ${input.result.error ?? "(no reason)"}.`,
    compliance_config_version: input.config_version,
  });

// ─────────────────────────────────────────────────────────────────────
// 4xx terminal-failure handling: FailedJob + admin notification
// ─────────────────────────────────────────────────────────────────────

const recordTerminalFailure = async (input: {
  job_id: string;
  job_data: unknown;
  org_id: string;
  uln: string;
  provider: string;
  error: string;
}) => {
  try {
    await FailedJob.create({
      queue_name: "mis-push",
      job_id: `${input.job_id}:${input.uln}`,
      job_data: input.job_data,
      error: `[${input.provider}] ${input.error}`,
      attempts: 1, // 4xx terminal — no retries
      created_at: new Date(),
    });
  } catch (err) {
    logger.error(
      { err: (err as Error).message, uln: input.uln },
      "processMisPush: FailedJob persist failed (push outcome already recorded)",
    );
  }

  try {
    await notificationsQueue.add("mis-push-failed", {
      channel: "email",
      recipientId: "amber-admin",
      type: "mis_push_failed",
      payload: {
        org_id: input.org_id,
        uln: input.uln,
        provider: input.provider,
        error: input.error,
      },
    });
  } catch (err) {
    logger.error(
      { err: (err as Error).message, uln: input.uln },
      "processMisPush: admin notification enqueue failed",
    );
  }
};

// ─────────────────────────────────────────────────────────────────────
// Single-learner push
// ─────────────────────────────────────────────────────────────────────

const processPushLearner = async (
  job: Job<MisPushJob>,
  data: Extract<MisPushJob, { kind: "push-learner" }>,
): Promise<MisPushJobResult> => {
  const { org_id, uln, requested_by } = data;
  const caller_id = requested_by ?? null;

  const key = singleIdempotencyKey(org_id, uln);
  const wrapped = await IdempotencyService.check(
    key,
    "mis-push",
    async () => runSingle(job, org_id, uln, caller_id),
    { org_id },
  );
  return wrapped.result;
};

const runSingle = async (
  job: Job<MisPushJob>,
  org_id: string,
  uln: string,
  caller_id: string | null,
): Promise<MisPushJobResult> => {
  // Resolve adapter — MISNotConfiguredError → skipped envelope
  let adapter: IMISAdapter;
  try {
    adapter = await getAdapter(org_id);
  } catch (err) {
    if (err instanceof MISNotConfiguredError) {
      logger.info(
        { org_id, uln, reason: err.reason },
        "processMisPush: skipping — org has no MIS configured",
      );
      return {
        kind: "push-learner",
        org_id,
        total: 1,
        held: 0,
        pushed: 0,
        failed: 0,
        skipped: true,
        per_record: [],
      };
    }
    throw err;
  }
  const provider = adapter.constructor.name.replace(/Adapter$/, "");

  // Build + validate
  const result = await buildAndValidate(org_id, uln);

  if (result.kind === "build_error") {
    logger.error(
      { org_id, uln, error: result.error },
      "processMisPush: build error — record cannot be assembled",
    );
    await recordTerminalFailure({
      job_id: String(job.id),
      job_data: job.data,
      org_id,
      uln,
      provider,
      error: `build_error: ${result.error}`,
    });
    return {
      kind: "push-learner",
      org_id,
      total: 1,
      held: 0,
      pushed: 0,
      failed: 1,
      skipped: false,
      per_record: [
        { uln, status: "build_error", error: result.error },
      ],
    };
  }

  if (result.kind === "held") {
    await auditHeld({
      org_id,
      uln,
      reasons: result.reasons,
      config_version: result.compliance_config_version,
      caller_id,
    });
    return {
      kind: "push-learner",
      org_id,
      total: 1,
      held: 1,
      pushed: 0,
      failed: 0,
      skipped: false,
      per_record: [
        { uln, status: "held", held_reasons: result.reasons },
      ],
    };
  }

  // Push — throws bubble (MISServerError / MISAuthError) per the
  // file-header contract.
  const pushResult = await adapter.pushLearner(result.record);

  // AuditLog the push outcome.
  await auditCompleted({
    org_id,
    uln,
    result: pushResult,
    config_version: result.validation.compliance_config_version,
    provider,
    caller_id,
  });

  if (!pushResult.success) {
    // 4xx terminal failure for this record. Mark FailedJob +
    // notify admin. We do NOT throw — that would re-queue the
    // whole job; 4xx is per-record terminal.
    await recordTerminalFailure({
      job_id: String(job.id),
      job_data: job.data,
      org_id,
      uln,
      provider,
      error: pushResult.error ?? "(no error message)",
    });
  }

  return {
    kind: "push-learner",
    org_id,
    total: 1,
    held: 0,
    pushed: pushResult.success ? 1 : 0,
    failed: pushResult.success ? 0 : 1,
    skipped: false,
    per_record: [
      {
        uln,
        status: pushResult.success ? "pushed" : "failed",
        provider_record_id: pushResult.provider_record_id,
        error: pushResult.error,
      },
    ],
  };
};

// ─────────────────────────────────────────────────────────────────────
// Batch push — same shape, multiplied
// ─────────────────────────────────────────────────────────────────────

const processPushBatch = async (
  job: Job<MisPushJob>,
  data: Extract<MisPushJob, { kind: "push-batch" }>,
): Promise<MisPushJobResult> => {
  const { org_id, ulns, requested_by } = data;
  const caller_id = requested_by ?? null;

  if (ulns.length === 0) {
    return {
      kind: "push-batch",
      org_id,
      total: 0,
      held: 0,
      pushed: 0,
      failed: 0,
      skipped: false,
      per_record: [],
    };
  }

  const key = batchIdempotencyKey(org_id, ulns);
  const wrapped = await IdempotencyService.check(
    key,
    "mis-push",
    async () => runBatch(job, org_id, ulns, caller_id),
    { org_id },
  );
  return wrapped.result;
};

const runBatch = async (
  job: Job<MisPushJob>,
  org_id: string,
  ulns: string[],
  caller_id: string | null,
): Promise<MisPushJobResult> => {
  let adapter: IMISAdapter;
  try {
    adapter = await getAdapter(org_id);
  } catch (err) {
    if (err instanceof MISNotConfiguredError) {
      logger.info(
        { org_id, batch_size: ulns.length, reason: err.reason },
        "processMisPush: skipping batch — org has no MIS configured",
      );
      return {
        kind: "push-batch",
        org_id,
        total: ulns.length,
        held: 0,
        pushed: 0,
        failed: 0,
        skipped: true,
        per_record: [],
      };
    }
    throw err;
  }
  const provider = adapter.constructor.name.replace(/Adapter$/, "");

  // Build + validate every record. Partition into ok / held /
  // build_error. Only the ok records reach the adapter.
  const built = await Promise.all(
    ulns.map((uln) => buildAndValidate(org_id, uln)),
  );

  const okRecords: MISRecord[] = [];
  const okIndexInBatch = new Map<string, number>(); // uln → index in okRecords
  const perRecord: MisPushJobResult["per_record"] = [];

  for (let i = 0; i < built.length; i++) {
    const b = built[i];
    if (b.kind === "build_error") {
      await recordTerminalFailure({
        job_id: String(job.id),
        job_data: job.data,
        org_id,
        uln: ulns[i],
        provider,
        error: `build_error: ${b.error}`,
      });
      perRecord.push({
        uln: ulns[i],
        status: "build_error",
        error: b.error,
      });
    } else if (b.kind === "held") {
      await auditHeld({
        org_id,
        uln: b.uln,
        reasons: b.reasons,
        config_version: b.compliance_config_version,
        caller_id,
      });
      perRecord.push({
        uln: b.uln,
        status: "held",
        held_reasons: b.reasons,
      });
    } else {
      okIndexInBatch.set(b.record.uln, okRecords.length);
      okRecords.push(b.record);
    }
  }

  // Adapter call — only on the ok subset. The adapter chunks at
  // its vendor cap; we get one result per record in input order.
  let pushResults: MISPushResult[] = [];
  if (okRecords.length > 0) {
    pushResults = await adapter.pushBatch(okRecords);
  }

  // Stitch pushResults back into perRecord in original input order.
  for (const record of okRecords) {
    const idx = okIndexInBatch.get(record.uln);
    if (idx === undefined) continue;
    const pr = pushResults[idx];

    // Find the originating ULN's slot in perRecord and complete
    // it. Build/held entries already populated above.
    const inputIdx = ulns.indexOf(record.uln);
    if (inputIdx === -1) continue;

    await auditCompleted({
      org_id,
      uln: record.uln,
      result: pr,
      // The held envelope carries config_version; pushed records
      // re-derive via the validator. For batch we surface the
      // adapter's view of the config — held + pushed in the same
      // batch share the same active config.
      config_version: null,
      provider,
      caller_id,
    });

    if (!pr.success) {
      await recordTerminalFailure({
        job_id: String(job.id),
        job_data: job.data,
        org_id,
        uln: record.uln,
        provider,
        error: pr.error ?? "(no error message)",
      });
    }

    // Insert into perRecord in input-order slot.
    perRecord.splice(inputIdx, 0, {
      uln: record.uln,
      status: pr.success ? "pushed" : "failed",
      provider_record_id: pr.provider_record_id,
      error: pr.error,
    });
  }

  // Final per-record reconciliation — input order, one row per ULN.
  // (`splice` inserts above may have produced duplicates if a UI
  // ULN appeared twice in the input; de-dupe on uln.)
  const seen = new Set<string>();
  const ordered = ulns.map((uln) => {
    seen.add(uln);
    return (
      perRecord.find(
        (r, i) => r.uln === uln && !perRecord.slice(0, i).some((r2) => r2.uln === uln),
      ) ?? { uln, status: "failed" as const, error: "missing from results" }
    );
  });

  return {
    kind: "push-batch",
    org_id,
    total: ulns.length,
    held: ordered.filter((r) => r.status === "held").length,
    pushed: ordered.filter((r) => r.status === "pushed").length,
    failed: ordered.filter(
      (r) => r.status === "failed" || r.status === "build_error",
    ).length,
    skipped: false,
    per_record: ordered,
  };
};

// ─────────────────────────────────────────────────────────────────────
// Public entry — dispatched from queueProcessors/index.ts
// ─────────────────────────────────────────────────────────────────────

export const processMisPush = async (
  job: Job<MisPushJob>,
): Promise<MisPushJobResult> => {
  const data = job.data;
  if (!data.org_id || !Types.ObjectId.isValid(data.org_id)) {
    throw new Error(
      `processMisPush: invalid org_id "${data.org_id}" on job ${job.id}`,
    );
  }

  try {
    if (data.kind === "push-learner") {
      return await processPushLearner(job, data);
    }
    return await processPushBatch(job, data);
  } catch (err) {
    // MISAuthError + MISServerError bubble through. Log them
    // before re-throw so BullMQ's failed-job path captures
    // structured context.
    if (err instanceof MISAuthError) {
      logger.error(
        {
          err: err.message,
          err_kind: "MISAuthError",
          org_id: data.org_id,
          provider: err.provider,
        },
        "processMisPush: MIS credentials rejected — pipeline halted, re-prompt org admin",
      );
    } else if (err instanceof MISServerError) {
      logger.warn(
        {
          err: err.message,
          err_kind: "MISServerError",
          http_status: err.http_status,
          org_id: data.org_id,
          provider: err.provider,
        },
        "processMisPush: MIS server error — BullMQ will retry",
      );
    }
    throw err;
  }
};

// Re-export for tests
export const __internals__ = {
  singleIdempotencyKey,
  batchIdempotencyKey,
  buildAndValidate,
  recordTerminalFailure,
};
