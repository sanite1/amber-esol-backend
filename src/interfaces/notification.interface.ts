import { Types, Document } from "mongoose";

/* ── Enums / Unions ── */

export type NotificationType =
  | "booking_created"
  | "booking_confirmed"
  | "booking_declined"
  | "booking_cancelled"
  | "booking_completed"
  | "booking_reminder"
  | "message_received"
  | "payment_processed"
  | "payment_failed"
  | "refund_processed"
  | "review_posted"
  | "review_reply"
  | "review_reported"
  | "review_hidden"
  | "review_restored"
  | "payout_requested"
  | "payout_completed"
  | "payout_rejected"
  | "account_suspended"
  | "account_reactivated"
  | "progression_ready"
  | "progression_confirmed"
  | "progression_rejected"
  // Function 17 — org-admin alert that a Stage 5 review has been opened
  | "stage5_review_initiated"
  | "system";

/* ══════════════════════════════════════════════
   Notification
   ══════════════════════════════════════════════ */

export interface INotification extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  type: NotificationType;
  title: string;
  message: string;
  data: Record<string, any>;
  read: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/* ══════════════════════════════════════════════
   Request body interfaces
   ══════════════════════════════════════════════ */

export interface ICreateNotificationPayload {
  userId: Types.ObjectId | string;
  type: NotificationType;
  title: string;
  message: string;
  data?: Record<string, any>;
}

export interface IBulkCreateNotificationPayload {
  userIds: (Types.ObjectId | string)[];
  type: NotificationType;
  title: string;
  message: string;
  data?: Record<string, any>;
}

/* ══════════════════════════════════════════════
   Query interfaces
   ══════════════════════════════════════════════ */

export interface INotificationQuery {
  page?: string;
  limit?: string;
  read?: string; // "true" | "false"
  type?: string; // comma-separated NotificationType values
  sort?: string; // "newest" | "oldest"
}

/* ══════════════════════════════════════════════
   WebSocket event payloads
   ══════════════════════════════════════════════ */

export interface NotificationSocketPayload {
  _id: string;
  type: NotificationType;
  title: string;
  message: string;
  data: Record<string, any>;
  read: boolean;
  createdAt: string;
}
