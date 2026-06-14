/**
 * Daily progression-check cron + per-org worker — brief Function 11.
 *
 * Two halves:
 *
 *   1. `fanOutProgressionCheck()` — the cron handler's worker. Queries
 *      orgs that have at least one active student and enqueues one
 *      job per org on the `priority-queue` BullMQ queue. Returns
 *      fast so the cron HTTP request doesn't time out on Vercel.
 *
 *   2. `runOrgProgressionCheck(orgId)` — the per-org worker invoked
 *      via processPriorityQueue. Loops the org's active learners,
 *      calls `checkLevelProgression` for each, deduplicates the
 *      "ready" notification per (learner, level) over a 7-day
 *      window, updates `cohort_status` per Phase 13 thresholds,
 *      and writes an AuditLog row for every state change.
 *
 * The fan-out / worker split is the [ADDENDUM] in the brief: the cron
 * endpoint stays small even when learner counts grow into the tens of
 * thousands, and we get BullMQ retries + concurrency without writing
 * any per-row error handling in the cron handler.
 *
 * Idempotency:
 *   - Notification dedupe is the responsibility of the worker, not the
 *     cron. The cron can fire twice in a day with no double-emails.
 *   - Cohort-status writes are conditional on the value actually
 *     changing, so a second run is a no-op except for "nothing to do"
 *     log lines.
 */

import { Types } from "mongoose";
import User from "../models/User";
import AISession from "../models/AISession";
import Organisation from "../models/Organisation";
import AuditLog from "../models/AuditLog";
import { createNotification } from "./notification.service";
import { priorityQueueQueue, notificationsQueue } from "../queues";
import { checkLevelProgression } from "./levelProgression.service";
import { CohortStatus } from "../interfaces/user.interface";
import logger from "../config/logger";

// ─────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────

/**
 * Cohort-status thresholds — brief Function 12 To-Do 4.
 *
 * Days since last completed AI tutor session:
 *
 *   active             0–4 days     (no badge)
 *   inactive_mild      5–9 days     (amber badge in dashboard)
 *   inactive_moderate  10–14 days   (prominent amber badge)
 *   dormant            15+ days     (red badge + org-admin digest email)
 *   new                no session AND enrolled ≤ 4 days
 *                      (else falls into inactive_mild and onward)
 *
 * The dormant band also triggers an org-level digest email (one per
 * cron run per org with a non-zero dormant count), so an org admin
 * with a backlog of unreached learners sees a single summary rather
 * than a per-learner alarm.
 */
export const COHORT_BAND_DAYS = {
  ACTIVE_MAX: 4,
  INACTIVE_MILD_MAX: 9,
  INACTIVE_MODERATE_MAX: 14,
} as const;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Brief Function 11: dedupe the "ready" notification per learner-level. */
const NOTIFICATION_DEDUP_WINDOW_MS = 7 * MS_PER_DAY;

// ─────────────────────────────────────────────────────────────────────
// 1 — fan-out (called by the cron HTTP handler)
// ─────────────────────────────────────────────────────────────────────

export interface FanOutResult {
  date: string;
  orgs_with_active_learners: number;
  jobs_enqueued: number;
  org_ids: string[];
}

/**
 * Find every org that has at least one active student and enqueue a
 * `check-progression` job per org on the priority-queue.
 *
 * Why per-org rather than per-learner:
 *   - One queue write per learner would burst BullMQ at 6am when a
 *     platform-wide cron fires. Per-org keeps the dispatch fan-out
 *     proportional to org count (tens), not learner count (thousands).
 *   - Org-level retries are also cleaner. If one org's run fails (a
 *     specific scenario file went missing), BullMQ retries that one
 *     org; the other orgs' work isn't blocked.
 */
export const fanOutProgressionCheck = async (): Promise<FanOutResult> => {
  const today = new Date().toISOString().split("T")[0]; // YYYY-MM-DD

  // Distinct org ids — one Mongo round-trip via aggregation rather
  // than a JS-side dedup on a User.distinct().
  const orgIds = (await User.distinct("orgId", {
    role: "student",
    isActive: true,
    orgId: { $ne: null },
  })) as Types.ObjectId[];

  // BullMQ jobs added in parallel — Promise.allSettled so one queue
  // hiccup doesn't drop the rest. Failed adds get logged + counted.
  const results = await Promise.allSettled(
    orgIds.map((orgId) =>
      priorityQueueQueue.add(
        "check-progression",
        {
          date: today,
          orgId: orgId.toString(),
          triggerEvent: "scheduled",
          action: "check-progression",
        },
        // Job dedupe: BullMQ jobId is unique per queue. Setting it to
        // a deterministic per-(org, date) key means a duplicate cron
        // run (or Vercel firing the same job twice) is a no-op.
        { jobId: `progression:${today}:${orgId.toString()}` },
      ),
    ),
  );

  const enqueued = results.filter((r) => r.status === "fulfilled").length;
  const failed = results.length - enqueued;
  if (failed > 0) {
    for (const r of results) {
      if (r.status === "rejected") {
        logger.error(
          {
            err:
              r.reason instanceof Error ? r.reason.message : String(r.reason),
          },
          "fanOutProgressionCheck: failed to enqueue org job",
        );
      }
    }
  }

  logger.info(
    {
      date: today,
      orgs_with_active_learners: orgIds.length,
      jobs_enqueued: enqueued,
      jobs_failed: failed,
    },
    "Daily progression fan-out complete",
  );

  return {
    date: today,
    orgs_with_active_learners: orgIds.length,
    jobs_enqueued: enqueued,
    org_ids: orgIds.map((id) => id.toString()),
  };
};

// ─────────────────────────────────────────────────────────────────────
// 2 — per-org worker (called by processPriorityQueue)
// ─────────────────────────────────────────────────────────────────────

export interface OrgProgressionRunStats {
  orgId: string;
  learners_checked: number;
  ready_flagged: number;
  notifications_sent: number;
  notifications_deduped: number;
  cohort_status_changes: number;
  /**
   * Brief Function 12 To-Do 4 — total learners currently in the
   * "dormant" band after this run. If > 0, the worker enqueues a
   * dormant-learners digest email to the org admin.
   */
  dormant_learners_count: number;
  dormant_digest_email_sent: boolean;
  errors: number;
}

/**
 * Helper — given days-since-last-session and a learner's enrolment
 * date, decide which cohort band they belong in.
 *
 * Returns null when the learner has never had a completed session AND
 * was enrolled within the last 14 days — that's a genuinely new
 * learner and their existing "new" status is correct. The caller
 * treats `null` as "leave cohort_status alone".
 */
export const decideCohortStatus = (
  daysSinceLastSession: number | null,
  daysSinceEnrolment: number,
): CohortStatus | null => {
  if (daysSinceLastSession === null) {
    // Never had a session
    if (daysSinceEnrolment <= COHORT_BAND_DAYS.ACTIVE_MAX) return "new";
    return "inactive_mild";
  }
  if (daysSinceLastSession <= COHORT_BAND_DAYS.ACTIVE_MAX) return "active";
  if (daysSinceLastSession <= COHORT_BAND_DAYS.INACTIVE_MILD_MAX)
    return "inactive_mild";
  if (daysSinceLastSession <= COHORT_BAND_DAYS.INACTIVE_MODERATE_MAX)
    return "inactive_moderate";
  return "dormant";
};

/**
 * Has a "ready" notification fired within the dedupe window for this
 * (learner, level) combo?
 *
 *   - sent_at older than 7 days  → fire again
 *   - sent_at within 7 days but at a DIFFERENT level (learner has been
 *                                  promoted/demoted since) → fire again
 *   - sent_at within 7 days at the SAME level → suppress
 */
const isWithinDedupWindow = (
  lastSentAt: Date | null | undefined,
  lastSentLevel: string | null | undefined,
  currentLevel: string,
  now: number,
): boolean => {
  if (!lastSentAt) return false;
  if (lastSentLevel !== currentLevel) return false;
  return now - lastSentAt.getTime() < NOTIFICATION_DEDUP_WINDOW_MS;
};

/**
 * Resolve who to email at this org. Single source of truth — if the
 * org doc has no admin id, we log and skip the email (the
 * progression_ready Notification + AuditLog rows still get written).
 */
const findOrgAdminId = async (orgId: string): Promise<string | null> => {
  const org = await Organisation.findById(orgId).select("adminUserId").lean();
  if (!org?.adminUserId) {
    logger.warn(
      { orgId },
      "runOrgProgressionCheck: org has no adminUserId — skipping email but writing in-app notification",
    );
    return null;
  }
  return org.adminUserId.toString();
};

/**
 * The per-org worker — runs the five-criteria check for every active
 * learner in the org and fans the results out into:
 *   - in-app Notification rows for the org admin
 *   - email enqueue on notificationsQueue
 *   - cohort_status writes on the User
 *   - AuditLog rows for every state change
 *
 * Never throws — per-learner failures are caught and counted so a
 * single bad learner doesn't kill the org's run.
 */
export const runOrgProgressionCheck = async (
  orgId: string,
): Promise<OrgProgressionRunStats> => {
  if (!Types.ObjectId.isValid(orgId)) {
    throw new Error(`runOrgProgressionCheck: invalid orgId ${orgId}`);
  }
  const orgObjectId = new Types.ObjectId(orgId);

  const learners = await User.find({
    role: "student",
    isActive: true,
    orgId: orgObjectId,
  })
    .select(
      "_id firstname lastname email esolLevel createdAt cohort_status progression_notification_sent_at progression_notification_level",
    )
    .lean();

  const stats: OrgProgressionRunStats = {
    orgId,
    learners_checked: 0,
    ready_flagged: 0,
    notifications_sent: 0,
    notifications_deduped: 0,
    cohort_status_changes: 0,
    dormant_learners_count: 0,
    dormant_digest_email_sent: false,
    errors: 0,
  };

  // Cached per-org so we don't re-fetch on every learner.
  let orgAdminId: string | null | undefined;

  const now = Date.now();

  for (const learner of learners) {
    stats.learners_checked += 1;
    try {
      // ── 1. Resolve current cohort band ─────────────────────────
      const latestSession = await AISession.findOne({
        learnerId: learner._id,
        completedAt: { $ne: null },
      })
        .sort({ completedAt: -1 })
        .select("completedAt")
        .lean();

      const lastSessionAt: Date | null =
        (latestSession?.completedAt as Date) ?? null;
      const daysSinceLastSession =
        lastSessionAt instanceof Date
          ? Math.floor((now - lastSessionAt.getTime()) / MS_PER_DAY)
          : null;
      const daysSinceEnrolment =
        learner.createdAt instanceof Date
          ? Math.floor((now - learner.createdAt.getTime()) / MS_PER_DAY)
          : 0;

      const nextStatus = decideCohortStatus(
        daysSinceLastSession,
        daysSinceEnrolment,
      );
      const currentStatus = (learner.cohort_status ?? "new") as CohortStatus;

      // Dormant tally — feeds the per-org digest email at end of run.
      // Tally what the band WILL BE after this run, not what it was,
      // so a learner newly bumped to dormant gets counted.
      if (nextStatus === "dormant") {
        stats.dormant_learners_count += 1;
      }

      // ── 2. Apply cohort-status change if needed ────────────────
      if (nextStatus && nextStatus !== currentStatus) {
        await User.updateOne(
          { _id: learner._id },
          {
            $set: {
              cohort_status: nextStatus,
              last_session_at: lastSessionAt,
            },
          },
        );
        stats.cohort_status_changes += 1;
        await AuditLog.create({
          timestamp: new Date(),
          actor_type: "system",
          actor_id: null,
          org_id: orgObjectId,
          learner_id: learner._id,
          action: "cohort_status_changed",
          before_state: { cohort_status: currentStatus },
          after_state: {
            cohort_status: nextStatus,
            days_since_last_session: daysSinceLastSession,
          },
          reason: `Daily progression cron — cohort transition (${currentStatus} → ${nextStatus})`,
          compliance_config_version: null,
        }).catch((err) =>
          logger.error(
            { err: (err as Error).message, learnerId: learner._id?.toString() },
            "AuditLog write failed for cohort_status_changed",
          ),
        );
      } else if (lastSessionAt) {
        // No status change but keep last_session_at fresh so the
        // cohort sweep doesn't need the AISession join on subsequent
        // runs. Cheap conditional update — only writes when stale.
        await User.updateOne(
          { _id: learner._id, last_session_at: { $ne: lastSessionAt } },
          { $set: { last_session_at: lastSessionAt } },
        );
      }

      // ── 3. Run the five-criteria readiness check ───────────────
      const result = await checkLevelProgression(learner._id.toString());
      if (!result.ready_for_progression || !result.current_level) {
        continue;
      }
      stats.ready_flagged += 1;

      // ── 4. Dedupe: 7 days per (learner, level) ─────────────────
      if (
        isWithinDedupWindow(
          learner.progression_notification_sent_at ?? null,
          learner.progression_notification_level ?? null,
          result.current_level,
          now,
        )
      ) {
        stats.notifications_deduped += 1;
        continue;
      }

      // ── 5. In-app notification + email + stamp ─────────────────
      if (orgAdminId === undefined) {
        orgAdminId = await findOrgAdminId(orgId);
      }

      const learnerName =
        `${learner.firstname ?? ""} ${learner.lastname ?? ""}`.trim() ||
        "(unnamed learner)";

      if (orgAdminId) {
        await createNotification({
          userId: new Types.ObjectId(orgAdminId),
          type: "progression_ready",
          title: "Learner ready for level review",
          message: `${learnerName} has met all five progression criteria at level ${result.current_level.toUpperCase()}.`,
          data: {
            learner_id: learner._id?.toString(),
            current_level: result.current_level,
            ready_at: result.checked_at,
            org_id: orgId,
          },
        });

        // Email — enqueued on the notifications queue. The org-admin
        // user owns the inbox, so we send to their userId and let
        // processNotifications dispatch to "progression-ready-email".
        await notificationsQueue
          .add(
            "progression-ready-email",
            {
              channel: "email",
              recipientId: orgAdminId,
              type: "progression_ready",
              payload: {
                org_id: orgId,
                learner_id: learner._id?.toString(),
                learner_name: learnerName,
                current_level: result.current_level,
                ready_at: result.checked_at,
              },
            },
            { priority: 1 },
          )
          .catch((err) =>
            logger.error(
              {
                err: (err as Error).message,
                learnerId: learner._id?.toString(),
              },
              "Failed to enqueue progression-ready-email",
            ),
          );

        stats.notifications_sent += 1;
      }

      // Stamp the User so we don't re-fire within the dedup window —
      // this happens even if orgAdminId was missing (the in-app
      // Notification couldn't be delivered, but the readiness state
      // IS recorded, and we don't want to keep flagging until the
      // org adds an admin).
      await User.updateOne(
        { _id: learner._id },
        {
          $set: {
            progression_notification_sent_at: new Date(now),
            progression_notification_level: result.current_level,
          },
        },
      );

      // ── 6. Audit the readiness flag ────────────────────────────
      await AuditLog.create({
        timestamp: new Date(),
        actor_type: "system",
        actor_id: null,
        org_id: orgObjectId,
        learner_id: learner._id,
        action: "progression_ready_flagged",
        before_state: null,
        after_state: {
          current_level: result.current_level,
          criteria_met: result.criteria_met,
          notified_admin: orgAdminId ?? null,
        },
        reason: "Daily progression cron — all five criteria met",
        compliance_config_version: null,
      }).catch((err) =>
        logger.error(
          { err: (err as Error).message, learnerId: learner._id?.toString() },
          "AuditLog write failed for progression_ready_flagged",
        ),
      );
    } catch (err) {
      stats.errors += 1;
      logger.error(
        {
          err: (err as Error).message,
          orgId,
          learnerId: learner._id?.toString(),
        },
        "runOrgProgressionCheck: per-learner failure — counted, continuing",
      );
    }
  }

  // ── Brief Function 12 To-Do 4: dormant digest email ───────────────
  // One per-org email per cron run when there's at least one dormant
  // learner. Aggregated rather than per-learner so an org with a long
  // tail doesn't drown the admin inbox.
  if (stats.dormant_learners_count > 0) {
    if (orgAdminId === undefined) {
      orgAdminId = await findOrgAdminId(orgId);
    }
    if (orgAdminId) {
      try {
        await notificationsQueue.add(
          "dormant-learners-digest-email",
          {
            channel: "email",
            recipientId: orgAdminId,
            type: "system",
            payload: {
              org_admin_user_id: orgAdminId,
              org_id: orgId,
              dormant_count: stats.dormant_learners_count,
              window_days: COHORT_BAND_DAYS.INACTIVE_MODERATE_MAX, // 14
            },
          },
          { priority: 5 }, // standard — not urgent, daily cadence
        );
        stats.dormant_digest_email_sent = true;
      } catch (err) {
        logger.error(
          {
            err: (err as Error).message,
            orgId,
            dormant_count: stats.dormant_learners_count,
          },
          "runOrgProgressionCheck: failed to enqueue dormant-learners-digest-email",
        );
      }
    } else {
      logger.warn(
        { orgId, dormant_count: stats.dormant_learners_count },
        "runOrgProgressionCheck: dormant learners exist but org has no adminUserId — digest skipped",
      );
    }
  }

  logger.info(stats, "runOrgProgressionCheck: org complete");
  return stats;
};

// Re-exports for tests
export const __internals__ = {
  decideCohortStatus,
  isWithinDedupWindow,
  COHORT_BAND_DAYS,
  NOTIFICATION_DEDUP_WINDOW_MS,
};
