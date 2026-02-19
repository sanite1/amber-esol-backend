import { Request, Response, NextFunction } from "express";
import {
  listNotificationsService,
  markNotificationReadService,
  markAllNotificationsReadService,
  deleteNotificationService,
  getUnreadCountService,
} from "../services/notification.service";

/* ── GET /notifications ── */
export const listNotifications = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = (req as any).user?.id?.toString();
    if (!userId) return res.status(401).json({ message: "Unauthorized" });
    const response = await listNotificationsService(userId, req.query as any);
    return res.status(response.statusCode).json(response);
  } catch (error) {
    next(error);
  }
};

/* ── GET /notifications/unread-count ── */
export const getUnreadCount = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = (req as any).user?.id?.toString();
    if (!userId) return res.status(401).json({ message: "Unauthorized" });
    const response = await getUnreadCountService(userId);
    return res.status(response.statusCode).json(response);
  } catch (error) {
    next(error);
  }
};

/* ── PATCH /notifications/:id/read ── */
export const markRead = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = (req as any).user?.id?.toString();
    if (!userId) return res.status(401).json({ message: "Unauthorized" });
    const response = await markNotificationReadService(userId, req.params.id);
    return res.status(response.statusCode).json(response);
  } catch (error) {
    next(error);
  }
};

/* ── PATCH /notifications/read-all ── */
export const markAllRead = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = (req as any).user?.id?.toString();
    if (!userId) return res.status(401).json({ message: "Unauthorized" });
    const response = await markAllNotificationsReadService(userId);
    return res.status(response.statusCode).json(response);
  } catch (error) {
    next(error);
  }
};

/* ── DELETE /notifications/:id ── */
export const deleteNotification = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = (req as any).user?.id?.toString();
    if (!userId) return res.status(401).json({ message: "Unauthorized" });
    const response = await deleteNotificationService(userId, req.params.id);
    return res.status(response.statusCode).json(response);
  } catch (error) {
    next(error);
  }
};
