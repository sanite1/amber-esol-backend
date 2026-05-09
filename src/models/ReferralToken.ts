import { Schema, model } from "mongoose";
import { IReferralToken } from "../interfaces/referralToken.interface";

const referralTokenSchema = new Schema<IReferralToken>(
  {
    orgId: { type: Schema.Types.ObjectId, ref: "Organisation", required: true },
    token: { type: String, required: true, unique: true },
    email: { type: String, lowercase: true, trim: true },
    esolLevel: { type: String },
    usedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
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

referralTokenSchema.index({ token: 1 }, { unique: true });
referralTokenSchema.index({ orgId: 1, isActive: 1 });
// NB: deliberately NO TTL — would destroy audit trail (usedBy/usedAt).
// Cleanup of expired-and-unused tokens should be a scheduled job.

const ReferralToken = model<IReferralToken>("ReferralToken", referralTokenSchema);

export default ReferralToken;
