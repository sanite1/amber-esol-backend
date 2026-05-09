import { Types, Document } from "mongoose";

export type SafeguardingAlertLevel = "low" | "medium" | "high" | "critical";
export type SafeguardingAlertStatus =
  | "open"
  | "reviewed"
  | "escalated"
  | "resolved"
  | "dismissed";

export interface ISafeguardingAlert extends Document {
  _id: Types.ObjectId;
  learnerId: Types.ObjectId;
  orgId: Types.ObjectId;
  sessionId: Types.ObjectId;
  alertLevel: SafeguardingAlertLevel;
  triggerTextHash: string;
  claudeReasoning?: string;
  reviewedBy?: Types.ObjectId;
  reviewedAt?: Date;
  status: SafeguardingAlertStatus;
  resolution?: string;
  notificationSentAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface IReviewAlertRequest {
  status: SafeguardingAlertStatus;
  resolution?: string;
}
