import { Request, Response, NextFunction } from "express";
import { getStudentDashboardService } from "../services/studentDashboard.service";

/* ── GET /api/student-dashboard ── */

export const getStudentDashboard = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = (req as any).user?.id;
    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const result = await getStudentDashboardService(
      userId.toString(),
      req.query as any,
    );

    return res.status(result.statusCode).json({
      message: result.message,
      data: result.data,
    });
  } catch (error) {
    next(error);
  }
};
