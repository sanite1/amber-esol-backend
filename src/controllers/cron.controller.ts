import { Request, Response, NextFunction } from "express";
import { autoCompleteLessonsService } from "../services/cron.service";
import { autoGenerateInvoicesCronService } from "../services/esolInvoice.service";
import { checkProgressionService } from "../services/esolProgression.service";
import { cacheRefreshQueue, notificationsQueue } from "../queues";
import ComplianceConfigService from "../services/ComplianceConfigService";

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
  next: NextFunction
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
  next: NextFunction
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
 * Daily cron (6am) — flags ESOL learners who have not had a session in
 * 14 days. Currently logs flagged learners only; future iteration will
 * dispatch nudge emails.
 */
export const cronCheckProgression = async (
  req: Request,
  res: Response,
  next: NextFunction
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

    const result = await checkProgressionService();

    return res.status(200).json({
      message: "Progression check completed",
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
  next: NextFunction
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
  next: NextFunction
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
 * Daily cron (6am) — Phase 23 teacher priority scoring run. For every
 * org with assigned teachers, computes the priority order of each
 * teacher's learners and writes the result back to User.teacher_priority_level
 * via the existing `priority-queue` BullMQ queue.
 *
 * STUB: the cron handler enqueues a daily-score job to surface the
 * intended wiring. The actual scoring algorithm is built in Phase 23 by
 * replacing the processPriorityQueue stub in
 * src/services/queueProcessors/index.ts.
 */
export const cronPriorityQueue = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    if (!requireCronSecret(req, res)) return;
    // TODO(Phase 23): replace processPriorityQueue stub with real scoring.
    return res.status(200).json({
      message: "Priority queue cron — stub (implementation pending Phase 23)",
      data: { triggered_at: new Date().toISOString() },
    });
  } catch (error) {
    next(error);
  }
};
