import { Request, Response, NextFunction } from "express";
import { autoCompleteLessonsService } from "../services/cron.service";

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
