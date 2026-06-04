/**
 * Delta-sync cron fan-out — Final Addendum §7.
 *
 * GET /api/cron/delta-sync (Vercel cron at 04:00 UTC daily) calls
 * `fanOutDeltaSync()`. It identifies every org that:
 *
 *   - has `misType !== "none"` (an MIS is configured), AND
 *   - has `billing_active === true` (the org is in good standing)
 *
 * and enqueues one `delta-sync` job per org. The per-org worker
 * (`processDeltaSync` in `processDeltaSync.ts`) does the actual
 * MIS-status comparison + discrepancy logging.
 *
 * Per-org fan-out (not platform-wide processing) means:
 *
 *   - A single bad org doesn't block the rest of the sweep.
 *   - BullMQ's retry policy gives the worker 3 attempts per org.
 *   - The cron handler itself stays O(orgs) cheap and quick — we
 *     enqueue jobs, return a count, and let the worker pool drain.
 */

import { Types } from "mongoose";
import Organisation from "../../models/Organisation";
import { deltaSyncQueue } from "../../queues";
import logger from "../../config/logger";

export interface FanOutDeltaSyncResult {
  date: string;
  orgs_eligible: number;
  jobs_enqueued: number;
  /** Orgs the cron skipped + the reason. Surfaced in the response for ops. */
  skipped: Array<{ org_id: string; reason: "no_mis" | "billing_inactive" }>;
}

/**
 * Identify eligible orgs and enqueue one job per org. Returns a
 * structured summary the cron handler echoes back in its JSON
 * response.
 */
export const fanOutDeltaSync = async (): Promise<FanOutDeltaSyncResult> => {
  const date = new Date().toISOString().slice(0, 10);

  // Read every org that has an MIS configured. We filter
  // billing_active in JS (rather than at query time) so the
  // skipped list captures `billing_inactive` cases too — useful
  // for ops to see "this org has an MIS but is paused".
  const orgs = await Organisation.find({
    misType: { $ne: "none" },
  })
    .select("_id misType billing_active")
    .lean();

  const skipped: FanOutDeltaSyncResult["skipped"] = [];
  let enqueued = 0;

  for (const org of orgs) {
    const orgId = (org._id as Types.ObjectId).toString();
    // billing_active default true — only an explicit `false`
    // pauses the sync.
    if ((org as { billing_active?: boolean }).billing_active === false) {
      skipped.push({ org_id: orgId, reason: "billing_inactive" });
      continue;
    }

    try {
      // Deterministic BullMQ jobId per (org, date) so a double-
      // firing of the cron (rare; Vercel cron retries on 5xx)
      // collapses onto one job.
      await deltaSyncQueue.add(
        "delta-sync",
        {
          date,
          orgId,
        },
        { jobId: `delta-sync:${orgId}:${date}` },
      );
      enqueued += 1;
    } catch (err) {
      logger.error(
        { err: (err as Error).message, orgId, date },
        "fanOutDeltaSync: enqueue failed for org (continuing with others)",
      );
    }
  }

  logger.info(
    {
      date,
      orgs_eligible: orgs.length,
      jobs_enqueued: enqueued,
      skipped_count: skipped.length,
    },
    "fanOutDeltaSync: complete",
  );

  return {
    date,
    orgs_eligible: orgs.length,
    jobs_enqueued: enqueued,
    skipped,
  };
};
