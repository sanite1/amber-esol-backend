import { Request, Response, NextFunction } from "express";
import { ExpressFunction } from "../interfaces/helper.interface";
import {
  ICreateReviewRequest,
  IUpdateReviewRequest,
  IReplyRequest,
  IReportRequest,
  IAdminReviewActionRequest,
  IAdminReportActionRequest,
  IReviewQuery,
  IAdminReviewQuery,
} from "../interfaces/review.interface";
import {
  createReviewService,
  getTutorReviewsService,
  getMyReviewsService,
  updateReviewService,
  deleteReviewService,
  addReplyService,
  updateReplyService,
  deleteReplyService,
  reportReviewService,
  toggleHelpfulService,
  reviewStatsService,
  adminListReviewsService,
  adminHideReviewService,
  adminUnhideReviewService,
  adminRemoveReviewService,
  adminRestoreReviewService,
  adminHandleReportService,
} from "../services/review.service";

/* ── Create Review (student) ── */

export const createReview: ExpressFunction<ICreateReviewRequest> = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const studentId = (req as any).user?.id?.toString();
    if (!studentId) return res.status(401).json({ message: "Unauthorized" });
    const data = await createReviewService(studentId, req.body);
    return res.status(data.statusCode).json(data);
  } catch (error) {
    next(error);
  }
};

/* ── Get Tutor Reviews (public) ── */

export const getTutorReviews = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const data = await getTutorReviewsService(
      req.params.tutorId,
      req.query as unknown as IReviewQuery
    );
    return res.status(200).json(data);
  } catch (error) {
    next(error);
  }
};

/* ── Get My Reviews (student) ── */

export const getMyReviews = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const studentId = (req as any).user?.id?.toString();
    if (!studentId) return res.status(401).json({ message: "Unauthorized" });
    const data = await getMyReviewsService(
      studentId,
      req.query as unknown as IReviewQuery
    );
    return res.status(200).json(data);
  } catch (error) {
    next(error);
  }
};

/* ── Update Review (student) ── */

export const updateReview: ExpressFunction<IUpdateReviewRequest> = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const studentId = (req as any).user?.id?.toString();
    if (!studentId) return res.status(401).json({ message: "Unauthorized" });
    const data = await updateReviewService(req.params.id, studentId, req.body);
    return res.status(data.statusCode).json(data);
  } catch (error) {
    next(error);
  }
};

/* ── Delete Review (student) ── */

export const deleteReview = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const studentId = (req as any).user?.id?.toString();
    if (!studentId) return res.status(401).json({ message: "Unauthorized" });
    const data = await deleteReviewService(req.params.id, studentId);
    return res.status(data.statusCode).json(data);
  } catch (error) {
    next(error);
  }
};

/* ── Add Reply (tutor) ── */

export const addReply: ExpressFunction<IReplyRequest> = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const tutorId = (req as any).user?.id?.toString();
    if (!tutorId) return res.status(401).json({ message: "Unauthorized" });
    const data = await addReplyService(req.params.id, tutorId, req.body);
    return res.status(data.statusCode).json(data);
  } catch (error) {
    next(error);
  }
};

/* ── Update Reply (tutor) ── */

export const updateReply: ExpressFunction<IReplyRequest> = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const tutorId = (req as any).user?.id?.toString();
    if (!tutorId) return res.status(401).json({ message: "Unauthorized" });
    const data = await updateReplyService(req.params.id, tutorId, req.body);
    return res.status(data.statusCode).json(data);
  } catch (error) {
    next(error);
  }
};

/* ── Delete Reply (tutor) ── */

export const deleteReply = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const tutorId = (req as any).user?.id?.toString();
    if (!tutorId) return res.status(401).json({ message: "Unauthorized" });
    const data = await deleteReplyService(req.params.id, tutorId);
    return res.status(data.statusCode).json(data);
  } catch (error) {
    next(error);
  }
};

/* ── Report Review ── */

export const reportReview: ExpressFunction<IReportRequest> = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = (req as any).user?.id?.toString();
    if (!userId) return res.status(401).json({ message: "Unauthorized" });
    const data = await reportReviewService(req.params.id, userId, req.body);
    return res.status(data.statusCode).json(data);
  } catch (error) {
    next(error);
  }
};

/* ── Toggle Helpful ── */

export const toggleHelpful = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = (req as any).user?.id?.toString();
    if (!userId) return res.status(401).json({ message: "Unauthorized" });
    const data = await toggleHelpfulService(req.params.id, userId);
    return res.status(data.statusCode).json(data);
  } catch (error) {
    next(error);
  }
};

/* ── Review Stats ── */

export const getReviewStats = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const data = await reviewStatsService(req.params.tutorId);
    return res.status(200).json(data);
  } catch (error) {
    next(error);
  }
};

/* ══════════════════════════════════════════════
   Admin Controllers
   ══════════════════════════════════════════════ */

/* ── Admin: List Reviews ── */

export const adminListReviews = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const data = await adminListReviewsService(
      req.query as unknown as IAdminReviewQuery
    );
    return res.status(200).json(data);
  } catch (error) {
    next(error);
  }
};

/* ── Admin: Hide Review ── */

export const adminHideReview: ExpressFunction<
  IAdminReviewActionRequest
> = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await adminHideReviewService(req.params.id, req.body);
    return res.status(data.statusCode).json(data);
  } catch (error) {
    next(error);
  }
};

/* ── Admin: Unhide Review ── */

export const adminUnhideReview: ExpressFunction<
  IAdminReviewActionRequest
> = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await adminUnhideReviewService(req.params.id, req.body);
    return res.status(data.statusCode).json(data);
  } catch (error) {
    next(error);
  }
};

/* ── Admin: Remove Review ── */

export const adminRemoveReview: ExpressFunction<
  IAdminReviewActionRequest
> = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await adminRemoveReviewService(req.params.id, req.body);
    return res.status(data.statusCode).json(data);
  } catch (error) {
    next(error);
  }
};

/* ── Admin: Restore Review ── */

export const adminRestoreReview: ExpressFunction<
  IAdminReviewActionRequest
> = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await adminRestoreReviewService(req.params.id, req.body);
    return res.status(data.statusCode).json(data);
  } catch (error) {
    next(error);
  }
};

/* ── Admin: Handle Report ── */

export const adminHandleReport: ExpressFunction<
  IAdminReportActionRequest
> = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await adminHandleReportService(
      req.params.id,
      req.params.reportId,
      req.body
    );
    return res.status(data.statusCode).json(data);
  } catch (error) {
    next(error);
  }
};
