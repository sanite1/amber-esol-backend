import { Schema, model } from "mongoose";
import { ITurnLog } from "../interfaces/turnLog.interface";

/**
 * TurnLog — append-only message audit trail.
 *
 * Same enforcement pattern as AuditLog / CalibrationLog / AIUsage:
 * pre-hooks block updates and deletes; the row is the row.
 *
 * Why a separate collection from AuditLog: AuditLog rows are
 * compliance events (small, structured, indexed for the org admin's
 * "what happened to my learner?" view). TurnLog rows are raw message
 * payloads that can run to thousands per learner and would dilute
 * the AuditLog if mixed. The two surface different consumers.
 */

const turnLogSchema = new Schema<ITurnLog>(
  {
    session_id: {
      type: Schema.Types.ObjectId,
      ref: "AISession",
      required: true,
      index: true,
    },
    learner_id: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    org_id: {
      type: Schema.Types.ObjectId,
      ref: "Organisation",
      required: true,
      index: true,
    },
    message: { type: String, required: true },
    safeguarding_scan: {
      type: new Schema(
        {
          triggered: { type: Boolean, required: true },
          category: { type: String, default: null },
          matched_pattern: { type: String, default: null },
        },
        { _id: false }
      ),
      required: true,
    },
    served_path: {
      type: String,
      enum: ["safeguarding_precache", "gemini", "ai_only_safeguarding"],
      required: true,
    },
    gemini_safeguarding_category: { type: String, default: null },
    timestamp: {
      type: Date,
      required: true,
      default: Date.now,
      index: true,
    },
  },
  {
    versionKey: false,
    timestamps: { createdAt: false, updatedAt: false },
    toJSON: { transform(_doc, ret) { delete ret.__v; } },
  }
);

turnLogSchema.index({ session_id: 1, timestamp: 1 });
turnLogSchema.index({ learner_id: 1, timestamp: -1 });
turnLogSchema.index({ org_id: 1, served_path: 1, timestamp: -1 });

const blockMutation = function (next: (err?: Error) => void) {
  next(new Error("TurnLog is append-only — updates and deletes are not permitted."));
};
turnLogSchema.pre(
  ["updateOne", "findOneAndUpdate", "updateMany"] as any,
  blockMutation
);
turnLogSchema.pre(
  ["deleteOne", "findOneAndDelete", "deleteMany"] as any,
  blockMutation
);
turnLogSchema.pre("save", function (next) {
  if (!this.isNew) {
    return next(new Error("TurnLog is append-only — re-saving an existing document is not permitted."));
  }
  next();
});

const TurnLog = model<ITurnLog>("TurnLog", turnLogSchema);
export default TurnLog;
