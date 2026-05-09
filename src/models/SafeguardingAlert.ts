import { Schema, model } from "mongoose";
import { ISafeguardingAlert } from "../interfaces/safeguardingAlert.interface";

const safeguardingAlertSchema = new Schema<ISafeguardingAlert>(
  {
    learnerId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    orgId: { type: Schema.Types.ObjectId, ref: "Organisation", required: true },
    sessionId: { type: Schema.Types.ObjectId, ref: "AISession", required: true },
    alertLevel: {
      type: String,
      enum: ["low", "medium", "high", "critical"],
      required: true,
    },
    triggerTextHash: { type: String, required: true },
    claudeReasoning: { type: String },
    reviewedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    reviewedAt: { type: Date, default: null },
    status: {
      type: String,
      enum: ["open", "reviewed", "escalated", "resolved", "dismissed"],
      default: "open",
    },
    resolution: { type: String },
    notificationSentAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret) {
        delete ret.__v;
      },
    },
  }
);

safeguardingAlertSchema.index({ orgId: 1, status: 1 });
safeguardingAlertSchema.index({ learnerId: 1 });
safeguardingAlertSchema.index({ alertLevel: 1, status: 1 });

const SafeguardingAlert = model<ISafeguardingAlert>(
  "SafeguardingAlert",
  safeguardingAlertSchema
);

export default SafeguardingAlert;
