import { Types } from "mongoose";
import ApiError from "../errors/apiError";
import ApiResponse from "../errors/apiResponse";
import Notification from "../models/Notification";
import {
  ICreateNotificationPayload,
  IBulkCreateNotificationPayload,
  INotificationQuery,
  NotificationSocketPayload,
} from "../interfaces/notification.interface";

/* ══════════════════════════════════════════════
   Internal: create & push notification
   (called by other services, NOT by a controller)
   ══════════════════════════════════════════════ */
export const createNotification = async (
  payload: ICreateNotificationPayload
): Promise<void> => {
  try {
    const notification = await Notification.create({
      userId: payload.userId,
      type: payload.type,
      title: payload.title,
      message: payload.message,
      data: payload.data || {},
    });

    // Emit via WebSocket if available
    emitNotification(notification.userId.toString(), {
      _id: notification._id.toString(),
      type: notification.type,
      title: notification.title,
      message: notification.message,
      data: notification.data,
      read: notification.read,
      createdAt: notification.createdAt.toISOString(),
    });
  } catch (error) {
    // Notification creation should never break the calling flow
    console.error("Failed to create notification:", error);
  }
};

export const createBulkNotifications = async (
  payload: IBulkCreateNotificationPayload
): Promise<void> => {
  try {
    const docs = payload.userIds.map((userId) => ({
      userId,
      type: payload.type,
      title: payload.title,
      message: payload.message,
      data: payload.data || {},
    }));

    const notifications = await Notification.insertMany(docs);

    // Emit to each user
    for (const notification of notifications) {
      emitNotification(notification.userId.toString(), {
        _id: notification._id.toString(),
        type: notification.type,
        title: notification.title,
        message: notification.message,
        data: notification.data,
        read: notification.read,
        createdAt: notification.createdAt.toISOString(),
      });
    }
  } catch (error) {
    console.error("Failed to create bulk notifications:", error);
  }
};

/* ══════════════════════════════════════════════
   WebSocket emit helper
   ══════════════════════════════════════════════ */
let ioInstance: any = null;

export const setNotificationIO = (io: any) => {
  ioInstance = io;
};

const emitNotification = (
  userId: string,
  payload: NotificationSocketPayload
) => {
  if (ioInstance) {
    ioInstance.to(`user:${userId}`).emit("notification:new", payload);
  }
};

export const emitUnreadCount = async (userId: string) => {
  if (!ioInstance) return;
  const count = await Notification.countDocuments({
    userId: new Types.ObjectId(userId),
    read: false,
  });
  ioInstance.to(`user:${userId}`).emit("notification:unread_count", { count });
};

/* ══════════════════════════════════════════════
   User-facing service functions
   ══════════════════════════════════════════════ */

export const listNotificationsService = async (
  userId: string,
  query: INotificationQuery
) => {
  const page = parseInt(query.page || "1", 10);
  const limit = parseInt(query.limit || "20", 10);
  const skip = (page - 1) * limit;

  // Build filter
  const filter: Record<string, any> = {
    userId: new Types.ObjectId(userId),
  };

  if (query.read === "true") filter.read = true;
  if (query.read === "false") filter.read = false;

  if (query.type) {
    const types = query.type.split(",").map((t) => t.trim());
    filter.type = { $in: types };
  }

  // Sort
  const sortOrder = query.sort === "oldest" ? 1 : -1;

  const [notifications, total, unreadCount] = await Promise.all([
    Notification.find(filter)
      .sort({ createdAt: sortOrder })
      .skip(skip)
      .limit(limit)
      .lean(),
    Notification.countDocuments(filter),
    Notification.countDocuments({
      userId: new Types.ObjectId(userId),
      read: false,
    }),
  ]);

  return new ApiResponse(200, "Notifications retrieved successfully", {
    notifications,
    unreadCount,
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
    },
  });
};

export const markNotificationReadService = async (
  userId: string,
  notificationId: string
) => {
  const notification = await Notification.findOne({
    _id: notificationId,
    userId: new Types.ObjectId(userId),
  });

  if (!notification) {
    throw new ApiError(404, "Notification not found");
  }

  if (notification.read) {
    return new ApiResponse(200, "Notification already read", { notification });
  }

  notification.read = true;
  await notification.save();

  // Emit updated unread count
  emitUnreadCount(userId);

  return new ApiResponse(200, "Notification marked as read", { notification });
};

export const markAllNotificationsReadService = async (userId: string) => {
  const result = await Notification.updateMany(
    { userId: new Types.ObjectId(userId), read: false },
    { $set: { read: true } }
  );

  // Emit updated unread count (now 0)
  emitUnreadCount(userId);

  return new ApiResponse(200, "All notifications marked as read", {
    modifiedCount: result.modifiedCount,
  });
};

export const deleteNotificationService = async (
  userId: string,
  notificationId: string
) => {
  const notification = await Notification.findOneAndDelete({
    _id: notificationId,
    userId: new Types.ObjectId(userId),
  });

  if (!notification) {
    throw new ApiError(404, "Notification not found");
  }

  // Emit updated unread count
  if (!notification.read) {
    emitUnreadCount(userId);
  }

  return new ApiResponse(200, "Notification deleted successfully", null);
};

/* ══════════════════════════════════════════════
   Unread count (used by other services/socket)
   ══════════════════════════════════════════════ */
export const getUnreadCountService = async (userId: string) => {
  const count = await Notification.countDocuments({
    userId: new Types.ObjectId(userId),
    read: false,
  });

  return new ApiResponse(200, "Unread count retrieved", { count });
};
