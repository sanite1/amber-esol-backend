import { Schema, model } from "mongoose";
import { ILevelChange } from "../interfaces/levelChange.interface";

const levelChangeSchema = new Schema<ILevelChange>(
  {
    learnerId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    orgId: { type: Schema.Types.ObjectId, ref: "Organisation", required: true },
    /**
     * Field-name mapping vs the brief's snake_case:
     *   brief `old_level`     ↔ Mongoose `fromLevel`
     *   brief `new_level`     ↔ Mongoose `toLevel`
     *   brief `confirmed_by`  ↔ Mongoose `changedBy`
     * Kept as camelCase to preserve back-compat with the legacy
     * level-change controller. Response shaping at the API layer
     * renames to the brief's snake_case so frontends see the brief.
     */
    fromLevel: { type: String, required: true },
    toLevel: { type: String, required: true },
    changedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    reason: { type: String, required: true },
    evidenceSummary: { type: String },
    sessionId: { type: Schema.Types.ObjectId, ref: "AISession", default: null },
    effectiveDate: { type: Date, required: true, default: Date.now },
    /**
     * Brief Function 11 To-Do 2 — what prompted this LevelChange.
     *
     *   - "progression_criteria_met" — Amber admin clicked Confirm on a
     *     learner who passed the daily five-criteria readiness check.
     *   - "teacher_override"         — a tutor moved the learner outside
     *     the readiness flow (e.g. compassionate demotion).
     *   - "manual_admin"             — Amber admin manual edit not tied
     *     to a readiness flag (rare; tracked for audit symmetry).
     *
     * Optional with no default — older LevelChange rows pre-dating
     * Function 11 won't have it, which is OK; new code reads it as
     * the discriminator for analytics.
     */
    triggerEvent: {
      type: String,
      enum: [
        "progression_criteria_met",
        "teacher_override",
        "manual_admin",
        null,
      ],
      default: null,
    },
  },
  {
    // Append-only: no updatedAt to signal immutability
    timestamps: { createdAt: true, updatedAt: false },
    toJSON: {
      transform(_doc, ret) {
        delete ret.__v;
      },
    },
  },
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
      "LevelChange is append-only — updates and deletes are not permitted.",
    ),
  );
};

levelChangeSchema.pre(
  ["updateOne", "findOneAndUpdate", "updateMany"] as any,
  blockUpdate,
);
levelChangeSchema.pre(
  ["deleteOne", "findOneAndDelete", "deleteMany"] as any,
  blockUpdate,
);
levelChangeSchema.pre("save", function (next) {
  if (!this.isNew) {
    return next(
      new Error(
        "LevelChange is append-only — re-saving an existing doc is not permitted.",
      ),
    );
  }
  next();
});

const LevelChange = model<ILevelChange>("LevelChange", levelChangeSchema);

export default LevelChange;
