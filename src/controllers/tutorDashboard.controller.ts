import { Request, Response, NextFunction } from "express";
import { ITutorDashboardQuery } from "../interfaces/tutorDashboard.interface";
import { getTutorDashboardService } from "../services/tutorDashboard.service";

/* ── GET /tutor-dashboard ── */

export const getTutorDashboard = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const tutorId = (req as any).user?.id?.toString();
    if (!tutorId) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    const data = await getTutorDashboardService(
      tutorId,
      req.query as unknown as ITutorDashboardQuery,
    );
    return res.status(200).json(data);
  } catch (error) {
    next(error);
  }
};
