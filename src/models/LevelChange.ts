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

// ── Immutability enforcement ─────────────────────────────────────────
// LevelChange is the legal audit trail for funding decisions. The brief
// requires updates and deletes to be blocked at the database layer so
// even an admin with raw Mongo access can't quietly rewrite history.
//
// `pre('save')` allows the initial create (isNew === true) but blocks
// re-saves of an existing document. The query-level hooks block any
// updateOne / findOneAndUpdate / updateMany / delete.
const blockUpdate = function (next: (err?: Error) => void) {
  next(
    new Error(
      "LevelChange is append-only — updates and deletes are not permitted."
    )
  );
};

levelChangeSchema.pre(
  ["updateOne", "findOneAndUpdate", "updateMany"] as any,
  blockUpdate
);
levelChangeSchema.pre(
  ["deleteOne", "findOneAndDelete", "deleteMany"] as any,
  blockUpdate
);
levelChangeSchema.pre("save", function (next) {
  if (!this.isNew) {
    return next(
      new Error("LevelChange is append-only — re-saving an existing doc is not permitted.")
    );
  }
  next();
});

const LevelChange = model<ILevelChange>("LevelChange", levelChangeSchema);

export default LevelChange;
