/**
 * Daily priority-recalc cron fan-out — Final Addendum §10, Todo 23.6.
 *
 * GET /api/cron/priority-queue (Vercel cron at 06:00 UTC daily)
 * calls `fanOutPriorityRecalc()`. It identifies every org that:
 *
 *   - has `billing_active === true` (the org is in good standing)
 *
 * and enqueues one `recalc-org-priorities` job per org on the
 * `priority-queue` BullMQ queue. The per-org worker
 * (`runOrgPriorityRecalc` in `priorityQueueRecalc.service.ts`)
 * does the actual per-learner evaluatePriority + writeback.
 *
 * Per-org fan-out (not platform-wide processing) means:
 *
 *   - A single bad org doesn't block the rest of the sweep.
 *   - BullMQ's retry policy gives the worker 3 attempts per org.
 *   - The cron handler itself stays O(orgs) cheap and returns
 *     immediately — Vercel function execution time stays bounded
 *     even when the platform grows past hundreds of orgs.
 *
 * Pattern symmetry with `fanOutDeltaSync`
 * =======================================
 *
 * This service deliberately mirrors `fanOutDeltaSync` in
 * `services/mis/deltaSyncCron.service.ts`: same return shape, same
 * skipped-reason capture, same per-org try/continue, same
 * deterministic jobId convention. An ops engineer reading both can
 * pattern-match instantly.
 *
 * The one shape difference: the priority cron has no MIS-config
 * predicate (every billing-active org has learners to recalc),
 * so there's no `no_mis` skipped reason — only `billing_inactive`.
 */

import { Types } from "mongoose";
import Organisation from "../models/Organisation";
import { priorityQueueQueue } from "../queues";
import logger from "../config/logger";

export interface FanOutPriorityRecalcResult {
  date: string;
  orgs_considered: number;
  jobs_enqueued: number;
  /** Orgs the cron skipped + the reason. Surfaced in the response for ops. */
  skipped: Array<{ org_id: string; reason: "billing_inactive" }>;
}

/**
 * Identify eligible orgs and enqueue one job per org. Returns a
 * structured summary the cron handler echoes back in its JSON
 * response and stamps onto the cron-dispatcher audit row.
 */
export const fanOutPriorityRecalc =
  async (): Promise<FanOutPriorityRecalcResult> => {
    const date = new Date().toISOString().slice(0, 10);

    // Read every org. We filter `billing_active` in JS (rather than
    // at query time) so the skipped list captures `billing_inactive`
    // cases for ops visibility — "we know about this org, we just
    // didn't recalc it today, and here's why".
    const orgs = await Organisation.find({})
      .select("_id billing_active")
      .lean();

    const skipped: FanOutPriorityRecalcResult["skipped"] = [];
    let enqueued = 0;

    for (const org of orgs) {
      const orgId = (org._id as Types.ObjectId).toString();
      // `billing_active` defaults to true on the Organisation schema;
      // only an explicit `false` pauses the recalc. Paused orgs still
      // exist in the dashboard — we just don't refresh their
      // priority signals while billing is suspended.
      if ((org as { billing_active?: boolean }).billing_active === false) {
        skipped.push({ org_id: orgId, reason: "billing_inactive" });
        continue;
      }

      try {
        // Deterministic BullMQ jobId per (org, date) so a double-
        // firing of the cron (rare — Vercel retries on 5xx) collapses
        // onto one job. The worker uses `job.id` as the Redis cache
        // runId for evaluatePriority, so a re-fire on the same date
        // hits the same cache namespace and amortises further.
        await priorityQueueQueue.add(
          "recalc-org-priorities",
          {
            date,
            orgId,
            action: "recalc-org-priorities",
            triggerEvent: "scheduled",
          },
          { jobId: `recalc-org-priorities:${orgId}:${date}` },
        );
        enqueued += 1;
      } catch (err) {
        logger.error(
          { err: (err as Error).message, orgId, date },
          "fanOutPriorityRecalc: enqueue failed for org (continuing with others)",
        );
      }
    }

    logger.info(
      {
        date,
        orgs_considered: orgs.length,
        jobs_enqueued: enqueued,
        skipped_count: skipped.length,
      },
      "fanOutPriorityRecalc: complete",
    );

    return {
      date,
      orgs_considered: orgs.length,
      jobs_enqueued: enqueued,
      skipped,
    };
  };
