import mongoose, { Schema } from "mongoose";
import { INotification } from "../interfaces/notification.interface";

const notificationSchema = new Schema<INotification>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    type: {
      type: String,
      enum: [
        "booking_created",
        "booking_confirmed",
        "booking_declined",
        "booking_cancelled",
        "booking_completed",
        "booking_reminder",
        "message_received",
        "payment_processed",
        "payment_failed",
        "refund_processed",
        "review_posted",
        "review_reply",
        "review_reported",
        "review_hidden",
        "review_restored",
        "payout_requested",
        "payout_completed",
        "payout_rejected",
        "account_suspended",
        "account_reactivated",
        "system",
      ],
      required: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
    },
    message: {
      type: String,
      required: true,
      trim: true,
    },
    data: {
      type: Schema.Types.Mixed,
      default: {},
    },
    read: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret) {
        delete ret.__v;
        return ret;
      },
    },
  }
);

/* ── Indexes ── */
notificationSchema.index({ userId: 1, createdAt: -1 });
notificationSchema.index({ userId: 1, read: 1 });
notificationSchema.index({ userId: 1, type: 1, createdAt: -1 });

const Notification = mongoose.model<INotification>(
  "Notification",
  notificationSchema
);

export default Notification;
