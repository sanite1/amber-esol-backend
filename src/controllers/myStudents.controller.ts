import { Request, Response, NextFunction } from "express";
import {
  listMyStudentsService,
  getMyStudentDetailService,
  updateStudentNotesService,
} from "../services/myStudents.service";

/* ── GET /my-students ── */
export const listMyStudents = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = (req as any).user?.id?.toString();
    if (!userId) return res.status(401).json({ message: "Unauthorized" });
    const response = await listMyStudentsService(userId, req.query as any);
    return res.status(response.statusCode).json(response);
  } catch (error) {
    next(error);
  }
};

/* ── GET /my-students/:studentId ── */
export const getMyStudentDetail = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = (req as any).user?.id?.toString();
    if (!userId) return res.status(401).json({ message: "Unauthorized" });
    const response = await getMyStudentDetailService(
      userId,
      req.params.studentId,
    );
    return res.status(response.statusCode).json(response);
  } catch (error) {
    next(error);
  }
};

/* ── PATCH /my-students/:studentId/notes ── */
export const updateStudentNotes = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = (req as any).user?.id?.toString();
    if (!userId) return res.status(401).json({ message: "Unauthorized" });
    const response = await updateStudentNotesService(
      userId,
      req.params.studentId,
      req.body.notes,
    );
    return res.status(response.statusCode).json(response);
  } catch (error) {
    next(error);
  }
};
