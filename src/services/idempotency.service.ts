import { Types } from "mongoose";
import IdempotencyKey from "../models/IdempotencyKey";
import {
  IdempotencyOperation,
} from "../interfaces/idempotencyKey.interface";
import logger from "../config/logger";

/**
 * IdempotencyService — "have we already done this?"
 *
 * Wraps a unit of work in a uniqueness lock backed by the IdempotencyKey
 * collection. The unique index on `key` is the lock: the first request
 * inserts a row with status="processing", runs `fn`, and patches the
 * row to status="completed" with the cached result. A second request
 * with the same key gets a duplicate-key error on insert, looks up the
 * existing row, and returns its cached result instead of re-running.
 *
 * Used by:
 *   - ILR export, RARPA evidence, MIS push (one-shot exports)
 *   - Learner bulk-import (brief Function 3) — key = sha256(org+email+dob)
 *     so re-uploading the same CSV doesn't create duplicate learners
 *   - Session writes — stops AI tutor double-charging on client retry
 *
 * Semantics:
 *   - `hit: false` → fresh run; `result` is whatever `fn` returned
 *   - `hit: true`  → cached; `result` is the prior run's result
 *
 * Failure handling:
 *   - If `fn` throws, the row is patched to status="failed" with the
 *     error message. Subsequent calls with the same key REPLAY the
 *     failure (we don't retry automatically) — that's intentional, the
 *     caller should change the key to retry. The TTL on the row (90 days)
 *     eventually releases it.
 *   - If the lock-insert itself races (concurrent identical requests),
 *     both might see "processing" briefly. The second caller polls the
 *     row a few times then gives up with a 409.
 */

const POLL_INTERVAL_MS = 50;
const POLL_TIMEOUT_MS = 5000;

export interface IdempotencyResult<T> {
  /** true if a previous call had already completed this key */
  hit: boolean;
  /** the cached or freshly produced result */
  result: T;
}

const isDuplicateKeyError = (err: unknown): boolean =>
  !!err &&
  typeof err === "object" &&
  // Mongo's E11000 driver error or mongoose's MongoServerError wrapper
  (("code" in err && (err as { code?: number }).code === 11000) ||
    ((err as { name?: string }).name === "MongoServerError" &&
      (err as { code?: number }).code === 11000));

const waitForCompletion = async (key: string) => {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const row = await IdempotencyKey.findOne({ key }).lean();
    if (row && row.status !== "processing") return row;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return null;
};

export interface IdempotencyLookupResult<T> {
  /** true if a completed row exists for this key. */
  hit: boolean;
  /** the cached result envelope, if hit. */
  result: T | null;
  /** raw row metadata for callers that need the org scope or timestamp. */
  meta: {
    org_id: Types.ObjectId | null;
    learner_id: Types.ObjectId | null;
    created_at: Date;
    status: "processing" | "completed" | "failed";
  } | null;
}

const IdempotencyService = {
  /**
   * Read-only cache lookup — brief Function 14 To-Do 5.
   *
   * Returns the cached result envelope when a completed row exists for
   * the key, with no side effects. Use this when the caller does its
   * own enqueueing on miss and only wants the cache short-circuit;
   * unlike `check()`, this never inserts, polls, or transitions any
   * row.
   *
   *   const { hit, result } = await IdempotencyService.lookup<EvidenceResult>(
   *     key,
   *     "rarpa-evidence",
   *   );
   *   if (hit) return result;       // cached → return URL inline
   *   // … enqueue fresh job …
   *
   * Rows with status="processing" or "failed" are reported as misses
   * (`hit: false`) so the caller can re-enqueue. The TTL on the row
   * (90 days, set on the IdempotencyKey schema) bounds how long a
   * completed result can be returned.
   */
  lookup: async <T>(
    key: string,
    operation: IdempotencyOperation,
  ): Promise<IdempotencyLookupResult<T>> => {
    const row = await IdempotencyKey.findOne({ key, operation }).lean();
    if (!row) return { hit: false, result: null, meta: null };
    const meta = {
      org_id: (row.org_id ?? null) as Types.ObjectId | null,
      learner_id: (row.learner_id ?? null) as Types.ObjectId | null,
      created_at: row.created_at,
      status: row.status,
    };
    if (row.status !== "completed") {
      return { hit: false, result: null, meta };
    }
    return { hit: true, result: row.result as T, meta };
  },

  /**
   * Wrap `fn` in an idempotency lock.
   *
   * @param key        Stable identifier for this operation (the caller
   *                   computes this — sha256 of inputs is idiomatic).
   * @param operation  Enum tag for the operation type. Used for analytics
   *                   and the compound index.
   * @param fn         The actual work. Receives no args; returns the
   *                   result to cache.
   * @param scope      Optional org_id / learner_id for the scoped index.
   */
  check: async <T>(
    key: string,
    operation: IdempotencyOperation,
    fn: () => Promise<T>,
    scope: {
      org_id?: string | Types.ObjectId | null;
      learner_id?: string | Types.ObjectId | null;
    } = {}
  ): Promise<IdempotencyResult<T>> => {
    // 1. Try to claim the lock.
    let lockRow;
    try {
      lockRow = await IdempotencyKey.create({
        key,
        operation,
        status: "processing",
        org_id: scope.org_id ?? null,
        learner_id: scope.learner_id ?? null,
      });
    } catch (err) {
      if (!isDuplicateKeyError(err)) throw err;
      // 2. Duplicate — somebody else owns this key. If their work is
      //    already done, return their cached result; otherwise wait.
      const existing =
        (await IdempotencyKey.findOne({ key }).lean()) ||
        (await waitForCompletion(key));
      if (!existing) {
        throw new Error(
          `Idempotency conflict on key ${key} — racing caller didn't finish in time`
        );
      }
      if (existing.status === "failed") {
        throw new Error(existing.error || "Prior call failed");
      }
      return { hit: true, result: existing.result as T };
    }

    // 3. We own the lock — run the work.
    try {
      const result = await fn();
      lockRow.status = "completed";
      lockRow.result = result;
      await lockRow.save().catch((err) =>
        logger.warn(
          { err, key },
          "Idempotency row commit failed (work succeeded — replay safe)"
        )
      );
      return { hit: false, result };
    } catch (err) {
      lockRow.status = "failed";
      lockRow.error =
        err instanceof Error ? err.message : "Unknown error";
      await lockRow.save().catch(() => {
        /* swallow — the original error matters more */
      });
      throw err;
    }
  },
};

export default IdempotencyService;
