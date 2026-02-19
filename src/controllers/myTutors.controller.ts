import { Request, Response, NextFunction } from "express";
import {
  listMyTutorsService,
  getMyTutorDetailService,
  toggleFavouriteTutorService,
} from "../services/myTutors.service";

/* ── GET /my-tutors ── */

export const listMyTutors = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = (req as any).user?.id?.toString();
    if (!userId) return res.status(401).json({ message: "Unauthorized" });
    const response = await listMyTutorsService(userId, req.query as any);
    return res.status(response.statusCode).json(response);
  } catch (error) {
    next(error);
  }
};

/* ── GET /my-tutors/:tutorId ── */

export const getMyTutorDetail = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = (req as any).user?.id?.toString();
    if (!userId) return res.status(401).json({ message: "Unauthorized" });
    const response = await getMyTutorDetailService(userId, req.params.tutorId);
    return res.status(response.statusCode).json(response);
  } catch (error) {
    next(error);
  }
};

/* ── POST /my-tutors/:tutorId/favourite ── */

export const toggleFavourite = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = (req as any).user?.id?.toString();
    if (!userId) return res.status(401).json({ message: "Unauthorized" });
    const response = await toggleFavouriteTutorService(
      userId,
      req.params.tutorId
    );
    return res.status(response.statusCode).json(response);
  } catch (error) {
    next(error);
  }
};
