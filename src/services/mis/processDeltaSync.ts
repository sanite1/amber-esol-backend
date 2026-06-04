/**
 * Per-org MIS delta-sync worker — Final Addendum §7.
 *
 * Pipeline (one job per org per day):
 *
 *   1. Resolve the org's adapter via `AdapterFactory`. If the org
 *      is no longer configured (admin changed misType to "none"
 *      between fan-out and worker pickup), exit cleanly.
 *   2. Load every learner in the org with a non-null ULN.
 *   3. For each learner, call `adapter.pullLearnerStatus(uln)`:
 *        - `null` → MIS doesn't know the learner. Notify Amber
 *          admin; AuditLog `mis_delta_unknown_learner`. **NEVER
 *          auto-delete from Project Silk** — the brief is explicit
 *          on this.
 *        - object → compare against Project Silk's derived state
 *          for the learner. If different, AuditLog
 *          `mis_delta_discrepancy` and notify org admins.
 *
 * Concurrency
 * ===========
 *
 * The `delta-sync` worker runs at `concurrency: 1` (per
 * `workers/deltaSync.worker.ts`) — one org sync at a time across
 * the platform — because each per-org sync may issue many
 * sequential `pullLearnerStatus` calls and most MIS vendors
 * rate-limit hard. Within an org we DO parallelise across
 * learners with a small concurrency cap so a 200-learner cohort
 * doesn't take 10 minutes serial.
 *
 * Discrepancy detection (MVP)
 * ===========================
 *
 * The MIS returns `{ status: string, last_updated: string }`. The
 * platform stores `User.status` (`active` | `withdrawn` | etc),
 * `User.isActive`, plus a derived "current level" via
 * `User.esolLevel`. MVP comparison is conservative — we map MIS
 * status to one of `{active, withdrawn, completed, other}` and
 * compare against Project Silk's derived bucket. ANY mismatch is
 * logged as a discrepancy; the org admin reviews and decides
 * whether to act. The platform NEVER auto-mutates learner state
 * based on MIS — the brief is explicit on this.
 */

import { Job } from "bullmq";
import { Types } from "mongoose";
import logger from "../../config/logger";
import User from "../../models/User";
import { createNotification } from "../notification.service";
import { writeAuditLog } from "../auditLog.service";
import { getAdapter } from "./AdapterFactory";
import {
  IMISAdapter,
  MISAuthError,
  MISNotConfiguredError,
  MISServerError,
} from "./types";
import type { DeltaSyncJob } from "../../queues";

// ─────────────────────────────────────────────────────────────────────
// Public result shape
// ─────────────────────────────────────────────────────────────────────

export interface DeltaSyncResult {
  org_id: string;
  date: string;
  status: "completed" | "skipped";
  /** "skipped" reasons. Empty when status is "completed". */
  reason?: "no_mis_configured" | "no_learners_with_uln";
  inspected: number;
  /** MIS doesn't know the ULN (alert Amber admin; never auto-delete). */
  unknown_to_mis: number;
  /** Status differs between MIS and Project Silk. */
  discrepancies: number;
  /** ULN status pull throwing transport errors (counted, not blocking). */
  transport_errors: number;
  /** ULNs the org admin should review. */
  flagged: string[];
}

// ─────────────────────────────────────────────────────────────────────
// Status bucketing — MVP conservative mapping
// ─────────────────────────────────────────────────────────────────────

type Bucket = "active" | "withdrawn" | "completed" | "other";

/**
 * Coerce a free-text MIS status string to a comparable bucket.
 * Vendors use wildly varying vocab; the bucket keeps the
 * comparison robust to wording differences.
 */
const bucketMisStatus = (raw: string): Bucket => {
  const s = raw.toLowerCase().trim();
  if (
    s.includes("withdraw") ||
    s.includes("transferr") ||
    s === "left"
  )
    return "withdrawn";
  if (
    s.includes("complete") ||
    s.includes("achiev") ||
    s.includes("finish")
  )
    return "completed";
  if (
    s.includes("active") ||
    s.includes("in learning") ||
    s.includes("in_learning") ||
    s.includes("continuing") ||
    s.includes("enrolled")
  )
    return "active";
  return "other";
};

/**
 * Project Silk's derived bucket for a learner. Reads only fields
 * we already have on the User doc — no extra Mongo round-trip.
 */
const bucketPlatformStatus = (learner: {
  isActive?: boolean;
  status?: string;
}): Bucket => {
  if (learner.isActive === false || learner.status === "terminated") {
    return "withdrawn";
  }
  if (learner.status === "completed") return "completed";
  if (learner.status === "active" || learner.isActive === true)
    return "active";
  return "other";
};

// ─────────────────────────────────────────────────────────────────────
// Per-learner sync
// ─────────────────────────────────────────────────────────────────────

interface LearnerProbe {
  uln: string;
  outcome:
    | "match"
    | "discrepancy"
    | "unknown"
    | "transport_error"
    | "no_status";
  mis_status?: string;
  mis_last_updated?: string;
  platform_status?: string;
  error?: string;
}

const probeLearner = async (
  adapter: IMISAdapter,
  learner: {
    _id: Types.ObjectId;
    uln: string;
    isActive?: boolean;
    status?: string;
  },
): Promise<LearnerProbe> => {
  try {
    const mis = await adapter.pullLearnerStatus(learner.uln);
    if (mis === null) {
      return { uln: learner.uln, outcome: "unknown" };
    }
    const misBucket = bucketMisStatus(mis.status);
    const platformBucket = bucketPlatformStatus(learner);
    if (misBucket !== platformBucket) {
      return {
        uln: learner.uln,
        outcome: "discrepancy",
        mis_status: mis.status,
        mis_last_updated: mis.last_updated,
        platform_status: platformBucket,
      };
    }
    return {
      uln: learner.uln,
      outcome: "match",
      mis_status: mis.status,
      platform_status: platformBucket,
    };
  } catch (err) {
    // Per-learner transport / auth errors are caught here so one
    // bad learner doesn't kill the whole org's sync. MISAuthError
    // is special — if one learner 401s, every learner will, so we
    // re-throw to bail the org. MISServerError on a single
    // learner is logged + counted; BullMQ retries the whole org
    // job if the sync ratio is bad.
    if (err instanceof MISAuthError) {
      throw err;
    }
    return {
      uln: learner.uln,
      outcome: "transport_error",
      error: (err as Error).message,
    };
  }
};

// ─────────────────────────────────────────────────────────────────────
// Bounded-parallelism helper — no extra dep
// ─────────────────────────────────────────────────────────────────────

const PER_ORG_CONCURRENCY = 5;

const mapWithConcurrency = async <T, R>(
  items: T[],
  worker: (item: T) => Promise<R>,
  limit: number,
): Promise<R[]> => {
  const results: R[] = new Array(items.length);
  let idx = 0;
  const lanes = new Array(Math.min(limit, items.length)).fill(0).map(
    async () => {
      while (true) {
        const i = idx++;
        if (i >= items.length) return;
        results[i] = await worker(items[i]);
      }
    },
  );
  await Promise.all(lanes);
  return results;
};

// ─────────────────────────────────────────────────────────────────────
// Discrepancy + unknown handlers — write audit + notify
// ─────────────────────────────────────────────────────────────────────

const recordDiscrepancy = async (input: {
  org_id: string;
  learner_id: Types.ObjectId;
  uln: string;
  mis_status: string;
  mis_last_updated?: string;
  platform_status: string;
}): Promise<void> => {
  await writeAuditLog({
    actor_type: "system",
    actor_id: null,
    org_id: input.org_id,
    learner_id: input.learner_id,
    action: "mis_delta_discrepancy",
    before_state: { platform_status: input.platform_status },
    after_state: {
      uln: input.uln,
      mis_status: input.mis_status,
      mis_last_updated: input.mis_last_updated ?? null,
    },
    reason: `MIS reports "${input.mis_status}" for ULN ${input.uln}; Project Silk has "${input.platform_status}". Review and reconcile.`,
  });

  // Notify every org admin so a single admin's absence doesn't
  // leave a discrepancy unactioned. Failure per admin doesn't
  // block the rest.
  try {
    const admins = await User.find({
      orgId: new Types.ObjectId(input.org_id),
      role: "org_admin",
    })
      .select("_id")
      .lean();
    await Promise.all(
      admins.map((a) =>
        createNotification({
          userId: a._id,
          type: "system",
          title: `MIS discrepancy — ULN ${input.uln}`,
          message: `MIS reports "${input.mis_status}"; Project Silk has "${input.platform_status}". Review the audit log for next steps.`,
          data: {
            uln: input.uln,
            mis_status: input.mis_status,
            platform_status: input.platform_status,
          },
        }).catch((err) =>
          logger.warn(
            { err: (err as Error).message, org_admin_id: a._id.toString() },
            "processDeltaSync: per-admin discrepancy notification failed",
          ),
        ),
      ),
    );
  } catch (err) {
    logger.error(
      { err: (err as Error).message, org_id: input.org_id },
      "processDeltaSync: org-admin lookup failed for discrepancy notification",
    );
  }
};

const recordUnknownLearner = async (input: {
  org_id: string;
  learner_id: Types.ObjectId;
  uln: string;
  provider: string;
}): Promise<void> => {
  await writeAuditLog({
    actor_type: "system",
    actor_id: null,
    org_id: input.org_id,
    learner_id: input.learner_id,
    action: "mis_delta_unknown_learner",
    before_state: null,
    after_state: {
      uln: input.uln,
      provider: input.provider,
    },
    reason:
      `${input.provider} has no record for ULN ${input.uln}. ` +
      `Project Silk has NOT deleted the learner — Amber admin must reconcile.`,
  });

  // Amber-admin notification — NOT org admin. The brief is
  // explicit: "if MIS no longer has the learner, alert Amber
  // admin". This usually indicates a more serious data-integrity
  // problem than a status discrepancy (the MIS may have been
  // reset, the learner may have been wrongly pushed, etc).
  try {
    const amberAdmins = await User.find({ role: "admin" })
      .select("_id")
      .lean();
    await Promise.all(
      amberAdmins.map((a) =>
        createNotification({
          userId: a._id,
          type: "system",
          title: `MIS unknown learner — ULN ${input.uln}`,
          message: `${input.provider} has no record for ULN ${input.uln} (org ${input.org_id}). Project Silk has NOT auto-deleted — please reconcile manually.`,
          data: {
            uln: input.uln,
            org_id: input.org_id,
            provider: input.provider,
          },
        }).catch((err) =>
          logger.warn(
            { err: (err as Error).message, amber_admin_id: a._id.toString() },
            "processDeltaSync: per-admin unknown-learner notification failed",
          ),
        ),
      ),
    );
  } catch (err) {
    logger.error(
      { err: (err as Error).message, org_id: input.org_id },
      "processDeltaSync: amber-admin lookup failed for unknown-learner notification",
    );
  }
};

// ─────────────────────────────────────────────────────────────────────
// Top-level entry — processDeltaSync
// ─────────────────────────────────────────────────────────────────────

export const processDeltaSync = async (
  job: Job<DeltaSyncJob>,
): Promise<DeltaSyncResult> => {
  const { orgId, date } = job.data;
  if (!orgId || !Types.ObjectId.isValid(orgId)) {
    throw new Error(
      `processDeltaSync: invalid orgId "${orgId}" on job ${job.id}`,
    );
  }

  // 1. Adapter — clean skip if no MIS (admin may have flipped to
  // "none" between fan-out and worker pickup).
  let adapter: IMISAdapter;
  try {
    adapter = await getAdapter(orgId);
  } catch (err) {
    if (err instanceof MISNotConfiguredError) {
      logger.info(
        { org_id: orgId, reason: err.reason },
        "processDeltaSync: skipping — org no longer has MIS configured",
      );
      return {
        org_id: orgId,
        date,
        status: "skipped",
        reason: "no_mis_configured",
        inspected: 0,
        unknown_to_mis: 0,
        discrepancies: 0,
        transport_errors: 0,
        flagged: [],
      };
    }
    throw err;
  }
  const provider = adapter.constructor.name.replace(/Adapter$/, "");

  // 2. Load learners with a ULN. role: "student" gates out any
  // accidentally-tagged non-learner Users.
  const learners = await User.find({
    orgId: new Types.ObjectId(orgId),
    role: "student",
    uln: { $exists: true, $nin: [null, ""] },
  })
    .select("_id uln isActive status")
    .lean();

  if (learners.length === 0) {
    logger.info(
      { org_id: orgId, date },
      "processDeltaSync: org has no learners with ULN — skipping",
    );
    return {
      org_id: orgId,
      date,
      status: "skipped",
      reason: "no_learners_with_uln",
      inspected: 0,
      unknown_to_mis: 0,
      discrepancies: 0,
      transport_errors: 0,
      flagged: [],
    };
  }

  // 3. Per-learner probes — bounded parallelism within the org
  // so a 200-learner cohort doesn't take 10 minutes serial. The
  // outer worker concurrency (1) still serialises across orgs.
  const probes = await mapWithConcurrency(
    learners,
    (l) =>
      probeLearner(adapter, {
        _id: l._id as Types.ObjectId,
        uln: (l as { uln: string }).uln,
        isActive: (l as { isActive?: boolean }).isActive,
        status: (l as { status?: string }).status,
      }),
    PER_ORG_CONCURRENCY,
  );

  // 4. Aggregate outcomes + emit audit/notifications.
  let unknown_to_mis = 0;
  let discrepancies = 0;
  let transport_errors = 0;
  const flagged: string[] = [];

  for (let i = 0; i < probes.length; i++) {
    const p = probes[i];
    const learner = learners[i];
    const learnerId = learner._id as Types.ObjectId;
    if (p.outcome === "unknown") {
      unknown_to_mis += 1;
      flagged.push(p.uln);
      await recordUnknownLearner({
        org_id: orgId,
        learner_id: learnerId,
        uln: p.uln,
        provider,
      });
    } else if (p.outcome === "discrepancy") {
      discrepancies += 1;
      flagged.push(p.uln);
      await recordDiscrepancy({
        org_id: orgId,
        learner_id: learnerId,
        uln: p.uln,
        mis_status: p.mis_status ?? "(unknown)",
        mis_last_updated: p.mis_last_updated,
        platform_status: p.platform_status ?? "(unknown)",
      });
    } else if (p.outcome === "transport_error") {
      transport_errors += 1;
      // No audit log per transport error — they're operational,
      // captured in the Pino warn line below + the worker's
      // failed-jobs record if the org-wide ratio is bad.
      logger.warn(
        {
          org_id: orgId,
          uln: p.uln,
          provider,
          error: p.error,
        },
        "processDeltaSync: per-learner transport error",
      );
    }
  }

  logger.info(
    {
      org_id: orgId,
      date,
      provider,
      inspected: learners.length,
      unknown_to_mis,
      discrepancies,
      transport_errors,
    },
    "processDeltaSync: complete",
  );

  return {
    org_id: orgId,
    date,
    status: "completed",
    inspected: learners.length,
    unknown_to_mis,
    discrepancies,
    transport_errors,
    flagged,
  };
};

// Re-export for tests
export const __internals__ = {
  bucketMisStatus,
  bucketPlatformStatus,
  probeLearner,
  mapWithConcurrency,
  recordDiscrepancy,
  recordUnknownLearner,
};
