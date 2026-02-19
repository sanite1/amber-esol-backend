import { Router } from "express";
// import { authMiddleware } from "../middlewares/authMiddleWare";
import {
  listNotifications,
  getUnreadCount,
  markRead,
  markAllRead,
  deleteNotification,
} from "../controllers/notification.controller";
import {
  listNotificationsValidation,
  markReadValidation,
  markAllReadValidation,
  deleteNotificationValidation,
} from "../validations/notification.validation";
import { isAuthenticated } from "../middlewares/authMiddleWare";

const router = Router();

// All routes require authentication (any role)
router.use(isAuthenticated);

router.get("/", listNotificationsValidation, listNotifications);
router.get("/unread-count", getUnreadCount);

// read-all must be before :id/read to avoid route conflict
router.patch("/read-all", markAllReadValidation, markAllRead);
router.patch("/:id/read", markReadValidation, markRead);

router.delete("/:id", deleteNotificationValidation, deleteNotification);

export default router;
