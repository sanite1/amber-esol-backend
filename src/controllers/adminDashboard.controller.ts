import { Request, Response, NextFunction } from "express";
import { getAdminDashboardService } from "../services/adminDashboard.service";

/* ── GET /api/admin-dashboard ── */

export const getAdminDashboard = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = (req as any).user?.id;
    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const result = await getAdminDashboardService(req.query as any);

    return res.status(result.statusCode).json({
      message: result.message,
      data: result.data,
    });
  } catch (error) {
    next(error);
  }
};
