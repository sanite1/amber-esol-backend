import { Schema, model } from "mongoose";
import { ISessionToken } from "../interfaces/sessionToken.interface";

const sessionTokenSchema = new Schema<ISessionToken>(
  {
    learnerId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    sessionId: {
      type: Schema.Types.ObjectId,
      ref: "AISession",
      required: true,
    },
    bookingId: {
      type: Schema.Types.ObjectId,
      ref: "Booking",
      default: null,
    },
    orgId: { type: Schema.Types.ObjectId, ref: "Organisation", required: true },
    token: { type: String, required: true, unique: true },
    usedAt: { type: Date, default: null },
    expiresAt: { type: Date, required: true },
    isActive: { type: Boolean, default: true },
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

sessionTokenSchema.index({ token: 1 }, { unique: true });
sessionTokenSchema.index({ sessionId: 1 });
sessionTokenSchema.index({ bookingId: 1 });
// NB: deliberately NO TTL — would destroy audit trail (usedAt/usedBy).
// Cleanup of expired-and-unused tokens should be a scheduled job.

const SessionToken = model<ISessionToken>("SessionToken", sessionTokenSchema);

export default SessionToken;
