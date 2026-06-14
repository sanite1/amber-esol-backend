import { Request, Response, NextFunction } from "express";
import { autoCompleteLessonsService } from "../services/cron.service";
import { autoGenerateInvoicesCronService } from "../services/esolInvoice.service";
import { fanOutProgressionCheck } from "../services/progressionCron.service";
import { cacheRefreshQueue, notificationsQueue } from "../queues";
import ComplianceConfigService from "../services/ComplianceConfigService";
import { runDemoReset } from "../services/demoReset.service";
import { fanOutDeltaSync } from "../services/mis/deltaSyncCron.service";
import { fanOutPriorityRecalc } from "../services/priorityQueueCron.service";
import { fanOutReEngagement } from "../services/reEngagementCron.service";
import { writeAuditLog } from "../services/auditLog.service";
import { IS_DEMO_MODE } from "../config/demoMode";
import logger from "../config/logger";

const requireCronSecret = (req: Request, res: Response): boolean => {
  const authHeader = req.headers.authorization;
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    res.status(500).json({ message: "CRON_SECRET is not configured" });
    return false;
  }
  if (authHeader !== `Bearer ${cronSecret}`) {
    res.status(401).json({ message: "Unauthorized" });
    return false;
  }
  return true;
};

/**
 * GET /api/cron/complete-lessons
 *
 * Called by Vercel Cron Jobs on a schedule. Protected by a shared
 * secret in the Authorization header so it can't be triggered by
 * arbitrary users.
 */
export const cronCompleteLessons = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    // ── Verify cron secret ──
    const authHeader = req.headers.authorization;
    const cronSecret = process.env.CRON_SECRET;

    if (!cronSecret) {
      return res.status(500).json({ message: "CRON_SECRET is not configured" });
    }

    if (authHeader !== `Bearer ${cronSecret}`) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const result = await autoCompleteLessonsService();

    return res.status(200).json({
      message: "Auto-complete cron executed successfully",
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/cron/generate-invoices
 *
 * Monthly cron (1st of each month at 9am) — generates invoices for the
 * previous full month for all active orgs with paymentModel === "invoiced".
 */
export const cronGenerateInvoices = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const authHeader = req.headers.authorization;
    const cronSecret = process.env.CRON_SECRET;

    if (!cronSecret) {
      return res.status(500).json({ message: "CRON_SECRET is not configured" });
    }
    if (authHeader !== `Bearer ${cronSecret}`) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const result = await autoGenerateInvoicesCronService();

    return res.status(200).json({
      message: "Invoice generation cron executed successfully",
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/cron/check-progression
 *
 * Daily cron (`0 6 * * *` per vercel.json) — brief Function 11.
 *
 * Auth: gated by `isCronAuthorized` middleware at the route layer
 * (see cron.routes.ts), which checks the shared CRON_SECRET. The
 * defensive recheck inline below mirrors the other handlers in this
 * file so a future refactor that removed the middleware would still
 * fail closed.
 *
 * Behaviour (brief addendum — async fan-out):
 *
 *   1. Resolve every org that has at least one active student.
 *   2. Enqueue ONE `check-progression` job per org on the
 *      `priority-queue` BullMQ queue. The worker
 *      (processPriorityQueue → runOrgProgressionCheck) does the heavy
 *      lifting: per-learner readiness checks, notifications, cohort
 *      status updates, audit log.
 *   3. Return the fan-out summary immediately. The handler does NOT
 *      wait for worker completion — that's the whole point of moving
 *      the work to the queue (keeps the Vercel function under its
 *      execution-time limit even when learner counts grow).
 *
 * Job IDs are deterministic (`progression:<date>:<orgId>`) so a
 * duplicate cron invocation in the same day is a BullMQ no-op rather
 * than producing duplicate notifications.
 */
export const cronCheckProgression = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const authHeader = req.headers.authorization;
    const cronSecret = process.env.CRON_SECRET;

    if (!cronSecret) {
      return res.status(500).json({ message: "CRON_SECRET is not configured" });
    }
    if (authHeader !== `Bearer ${cronSecret}`) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const result = await fanOutProgressionCheck();

    logger.info(
      {
        date: result.date,
        orgs: result.orgs_with_active_learners,
        jobs_enqueued: result.jobs_enqueued,
      },
      "cronCheckProgression: fan-out enqueued",
    );

    return res.status(200).json({
      message: "Progression check fan-out enqueued",
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/cron/postcode-refresh-alert
 *
 * Annual cron (1 August at 08:00) — sends an Amber admin notification
 * reminding Joey to download the new DfE ASF postcode file and trigger
 * POST /api/admin/cache/postcode/reload. Does NOT auto-load: human
 * verification of the new file format is required.
 */
export const cronPostcodeRefreshAlert = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    if (!requireCronSecret(req, res)) return;

    const academicYear = ComplianceConfigService.currentAcademicYear();
    await notificationsQueue.add("postcode_refresh_due", {
      channel: "email",
      recipientId: "amber-admin",
      type: "postcode_refresh_due",
      payload: {
        academicYear,
        action_url: "/api/admin/cache/postcode/reload",
        message: `The DfE ASF postcode dataset for ${academicYear} is now available. Download from gov.uk, verify the file format, then call POST /api/admin/cache/postcode/reload to refresh Redis.`,
      },
    });

    return res.status(200).json({
      message: "Postcode refresh alert enqueued",
      data: { academicYear },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/cron/fala-refresh
 *
 * Monthly cron (1st of each month at 08:00) — enqueues a FALA whitelist
 * reload. Unlike the postcode refresh this DOES auto-trigger, because the
 * FALA list is small, the source is internal, and no file-format surprises
 * are possible.
 */
export const cronFalaRefresh = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    if (!requireCronSecret(req, res)) return;

    const academicYear = ComplianceConfigService.currentAcademicYear();
    const job = await cacheRefreshQueue.add("fala-refresh", {
      task: "fala-refresh",
      academicYear,
    });

    return res.status(200).json({
      message: "FALA refresh enqueued",
      data: { jobId: String(job.id), academicYear },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/cron/priority-queue
 *
 * Daily cron (06:00 UTC) — Final Addendum §10, Todo 23.6. Fans out
 * one `recalc-org-priorities` job per `billing_active` org. The
 * per-org worker (`runOrgPriorityRecalc`) loads every learner in
 * the org, calls `evaluatePriority` for each, writes the verdict
 * back to `User.teacher_priority_level` + `teacher_recommended_action`
 * + `teacher_priority_trigger_key`, and writes a summary audit row.
 *
 * Auth chain on every call
 * ========================
 *
 *   isCronAuthorized middleware (route layer)
 *     → requireCronSecret (controller belt-and-braces — same
 *       check, kept symmetric with the other cron handlers so a
 *       hypothetical mis-routed call still refuses)
 *     → fanOutPriorityRecalc()
 *     → writeAuditLog("priority_queue_cron_dispatched")
 *
 * Idempotency
 * ===========
 *
 * Per-org jobIds are deterministic (`recalc-org-priorities:<orgId>:<date>`),
 * so a double-firing of the cron (Vercel retries on 5xx) collapses
 * onto one job per org per day. The audit row, however, is appended
 * on every cron invocation — that's intentional: the audit trail
 * needs to record "the cron handler ran on date X", separately
 * from whether each per-org job actually executed.
 *
 * Atomicity
 * =========
 *
 * The audit row is best-effort (writeAuditLog swallows persist
 * failures). The fan-out summary is the durable signal — if the
 * audit write fails but the jobs land, the recalc still happens
 * and the per-org summary audit rows from `runOrgPriorityRecalc`
 * still record what changed downstream.
 */
export const cronPriorityQueue = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    if (!requireCronSecret(req, res)) return;

    const result = await fanOutPriorityRecalc();

    // System-actor audit row — actor_id null, org_id null
    // (platform-wide event), reason carries the human-readable
    // summary so the org-admin audit-log UI surfaces it without
    // needing a join.
    await writeAuditLog({
      actor_type: "system",
      actor_id: null,
      org_id: null,
      learner_id: null,
      action: "priority_queue_cron_dispatched",
      before_state: null,
      after_state: {
        date: result.date,
        orgs_considered: result.orgs_considered,
        jobs_enqueued: result.jobs_enqueued,
        skipped: result.skipped,
      },
      reason:
        `Daily priority recalc dispatched: ${result.jobs_enqueued} of ` +
        `${result.orgs_considered} org${result.orgs_considered === 1 ? "" : "s"} enqueued` +
        (result.skipped.length > 0
          ? `, ${result.skipped.length} skipped (billing_inactive)`
          : "") +
        `.`,
    });

    logger.info(
      {
        date: result.date,
        orgs_considered: result.orgs_considered,
        jobs_enqueued: result.jobs_enqueued,
        skipped_count: result.skipped.length,
      },
      "cronPriorityQueue: fan-out enqueued",
    );

    return res.status(200).json({
      message: "Priority recalc fan-out enqueued",
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/cron/reset-demo-environment
 *
 * Daily cron (03:00 UTC) — brief Function 16. ONLY runs on the demo
 * Vercel deployment. The chain of guards is:
 *
 *   1. DEMO_MODE === true. Refused with 403 otherwise. This check
 *      runs BEFORE the cron-secret check so that a misconfigured
 *      prod deployment that somehow had the cron registered would
 *      refuse even with a valid secret — production data is the
 *      blast radius this guards against.
 *   2. Cron secret valid (Authorization: Bearer <CRON_SECRET>).
 *      Stops casual external pokers.
 *   3. runDemoReset() returns a structured result envelope. We map
 *      `ok: true` → 200, `ok: false` → 500 so Vercel's cron-failure
 *      alerts surface real problems.
 *
 * The service handles the drop + seed + outcome email. This handler
 * is a thin gate.
 */
export const cronResetDemoEnvironment = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    // ── Guard #1 — fail-closed on DEMO_MODE before any secret check.
    if (!IS_DEMO_MODE) {
      logger.error(
        "cronResetDemoEnvironment: refused — DEMO_MODE is not enabled on this process",
      );
      return res.status(403).json({
        message:
          "Demo reset refused: DEMO_MODE is not enabled on this server. This endpoint never touches production data.",
      });
    }

    // ── Guard #2 — cron secret.
    if (!requireCronSecret(req, res)) return;

    // ── Run the reset. Service never throws; reads `ok` to map status.
    const result = await runDemoReset();
    const status = result.ok ? 200 : 500;
    logger.info(
      {
        ok: result.ok,
        dropped_count: result.dropped.length,
        reason: result.reason ?? null,
      },
      "cronResetDemoEnvironment: complete",
    );
    return res.status(status).json({
      message: result.ok
        ? "Demo environment reset complete"
        : "Demo environment reset failed",
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/cron/delta-sync
 *
 * Daily cron (04:00 UTC) — Final Addendum §7. Fans out one
 * `delta-sync` job per org that has an MIS configured and is
 * billing-active. The per-org worker pulls learner status from
 * the MIS and records discrepancies — see
 * `services/mis/processDeltaSync.ts`.
 *
 * Cron handler stays cheap (O(orgs) enqueues, returns immediately);
 * the worker pool does the per-org MIS work asynchronously.
 */
export const cronDeltaSync = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    if (!requireCronSecret(req, res)) return;

    const result = await fanOutDeltaSync();
    logger.info(
      {
        date: result.date,
        orgs_eligible: result.orgs_eligible,
        jobs_enqueued: result.jobs_enqueued,
        skipped_count: result.skipped.length,
      },
      "cronDeltaSync: fan-out enqueued",
    );

    return res.status(200).json({
      message: "Delta-sync fan-out enqueued",
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/cron/re-engagement
 *
 * Weekdays at 09:00 UTC — Final Addendum §11. Sweeps the dormant
 * cohort, sends an auto-templated "checking in" message on each
 * eligible teacher's behalf, and writes a summary audit row.
 *
 * Auth chain on every call
 * ========================
 *
 *   isCronAuthorized (route middleware)
 *     → requireCronSecret (controller belt-and-braces)
 *     → fanOutReEngagement()
 *
 * The cron does the heavy lifting inline (no fan-out to a per-org
 * worker queue) because the brief's 50/run cap keeps the wall-
 * clock bounded — even with a Gemini translation per learner the
 * full run fits inside Vercel's function-execution budget.
 *
 * Schedule choice
 * ===============
 *
 * Mon-Fri at 09:00 UTC is the brief's "friendlier timezone
 * alignment" — that's mid-morning for UK learners, early
 * afternoon for European, and late evening for east-coast US.
 * Saturday + Sunday are excluded so learners don't get a
 * "checking in" prompt during their down time; the next firing
 * is Monday morning.
 */
export const cronReEngagement = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    if (!requireCronSecret(req, res)) return;

    const result = await fanOutReEngagement();
    logger.info(
      {
        date: result.date,
        dormant_cohort_size: result.dormant_cohort_size,
        messages_sent: result.messages_sent,
        skipped: result.skipped,
      },
      "cronReEngagement: complete",
    );
    return res.status(200).json({
      message: "Re-engagement cron complete",
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/cron/academic-year-transition
 *
 * Annual cron (1 August at 06:00) — Final Addendum §3: "auto-activate
 * new year config on 1 August each year. Retain previous year for
 * historical record lookups."
 *
 * Per domain (ilr / rarpa / asf-routing):
 *   - active config for the NEW academic year already exists → no-op
 *   - a pre-created (inactive) config for the new year exists →
 *     activate the latest version
 *   - nothing pre-created → ROLL OVER the previous year's active
 *     rules as v1 of the new year, with a changelog telling the admin
 *     to review for the year's ILR changes
 *   - no prior config either → flagged in the admin alert; that
 *     domain keeps failing closed until a config is seeded
 *
 * The previous year's documents are never touched — getConfig() is
 * keyed on (domain, year), so historical lookups keep resolving.
 * Every change writes a `compliance_config_activated` audit row with
 * actor_type "system", and an Amber-admin notification summarises
 * what happened so the auto-rolled rules get human review.
 */
export const cronAcademicYearTransition = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    if (!requireCronSecret(req, res)) return;

    const { default: ComplianceConfig } = await import(
      "../models/ComplianceConfig"
    );

    const year = ComplianceConfigService.currentAcademicYear();
    // "2026/27" → "2025/26"
    const startYear = parseInt(year.slice(0, 4), 10);
    const prevYear = `${startYear - 1}/${String(startYear).slice(-2)}`;

    const DOMAINS = ["ilr", "rarpa", "asf-routing"] as const;
    const results: Array<{ domain: string; status: string; version?: number }> =
      [];

    for (const domain of DOMAINS) {
      if (ComplianceConfigService.getConfig(domain, year)) {
        results.push({ domain, status: "already_active" });
        continue;
      }

      // Pre-created (inactive) config for the new year → activate it.
      const preCreated = await ComplianceConfig.findOne({
        domain,
        academic_year: year,
      }).sort({ version: -1 });

      let activated: { version: number; rules: unknown } | null = null;
      let status = "";

      if (preCreated) {
        preCreated.active = true;
        await preCreated.save();
        activated = { version: preCreated.version, rules: preCreated.rules };
        status = "activated_precreated";
      } else {
        const prior = await ComplianceConfig.findOne({
          domain,
          academic_year: prevYear,
          active: true,
        }).lean();
        if (!prior) {
          results.push({ domain, status: "missing_no_prior_config" });
          continue;
        }
        const created = await ComplianceConfig.create({
          domain,
          academic_year: year,
          version: 1,
          active: true,
          rules: prior.rules,
          updated_by: null,
          updated_at: new Date(),
          changelog:
            `Auto-rolled over from ${prevYear} active config (v${prior.version}) ` +
            `by the 1 August academic-year transition cron. REVIEW REQUIRED — ` +
            `apply the ${year} specification changes via the compliance-config editor.`,
        });
        activated = { version: created.version, rules: created.rules };
        status = "rolled_over_from_previous_year";
      }

      await writeAuditLog({
        actor_type: "system",
        actor_id: null,
        org_id: null,
        learner_id: null,
        action: "compliance_config_activated",
        before_state: { domain, academic_year: year, active: null },
        after_state: {
          domain,
          academic_year: year,
          version: activated?.version ?? null,
          status,
        },
        reason:
          `Academic-year transition cron: ${domain} / ${year} ` +
          `v${activated?.version} ${status === "rolled_over_from_previous_year" ? `rolled over from ${prevYear} — needs review` : "activated"}.`,
        compliance_config_version: activated?.version ?? null,
      });

      results.push({ domain, status, version: activated?.version });
    }

    await ComplianceConfigService.loadAll();

    // Alert the Amber admin whenever the cron had to act (or failed
    // to) — silent auto-rollover of funding rules would be worse
    // than no automation at all.
    const needsAttention = results.filter((r) => r.status !== "already_active");
    if (needsAttention.length > 0) {
      await notificationsQueue
        .add("academic_year_transition", {
          channel: "email",
          recipientId: "amber-admin",
          type: "academic_year_transition",
          payload: {
            academicYear: year,
            results,
            message:
              `Academic-year transition for ${year}: ` +
              needsAttention
                .map((r) => `${r.domain} → ${r.status}`)
                .join("; ") +
              ". Rolled-over configs carry last year's rules — review and apply this year's specification changes in the compliance-config editor.",
          },
        })
        .catch((err) =>
          logger.error(
            { err: (err as Error).message },
            "cronAcademicYearTransition: admin alert enqueue failed",
          ),
        );
    }

    logger.info({ year, results }, "cronAcademicYearTransition: complete");
    return res.status(200).json({
      message: "Academic-year transition complete",
      data: { academic_year: year, results },
    });
  } catch (error) {
    next(error);
  }
};
