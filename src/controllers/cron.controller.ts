import { Request, Response, NextFunction } from "express";
import { autoCompleteLessonsService } from "../services/cron.service";
import { autoGenerateInvoicesCronService } from "../services/esolInvoice.service";
import { checkProgressionService } from "../services/esolProgression.service";

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
