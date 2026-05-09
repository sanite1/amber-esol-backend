import { Schema, model } from "mongoose";
import { ILevelChange } from "../interfaces/levelChange.interface";

const levelChangeSchema = new Schema<ILevelChange>(
  {
    learnerId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    orgId: { type: Schema.Types.ObjectId, ref: "Organisation", required: true },
    fromLevel: { type: String, required: true },
    toLevel: { type: String, required: true },
    changedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    reason: { type: String, required: true },
    evidenceSummary: { type: String },
    sessionId: { type: Schema.Types.ObjectId, ref: "AISession", default: null },
    effectiveDate: { type: Date, required: true, default: Date.now },
  },
  {
    // Append-only: no updatedAt to signal immutability
    timestamps: { createdAt: true, updatedAt: false },
    toJSON: {
      transform(_doc, ret) {
        delete ret.__v;
      },
    },
  }
);

levelChangeSchema.index({ learnerId: 1, createdAt: -1 });
levelChangeSchema.index({ orgId: 1, createdAt: -1 });

const LevelChange = model<ILevelChange>("LevelChange", levelChangeSchema);

export default LevelChange;
