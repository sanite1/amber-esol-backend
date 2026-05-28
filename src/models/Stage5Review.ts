import { Schema, model } from "mongoose";
import { IStage5Review } from "../interfaces/stage5Review.interface";

/**
 * Stage5Review — end-of-level RARPA review (Phase 11).
 *
 * Created automatically when a learner completes the threshold criteria
 * for a level. Captures the learner's own self-assessment, the AI tutor's
 * narrative summary, and (eventually) the org admin's confirmation.
 *
 * `stage3_objectives` is a snapshot copy of the objectives the learner
 * was working against — they may be edited on the User record later, but
 * the Stage 5 review must show what was assessed at the time.
 */

const stage5ReviewSchema = new Schema<IStage5Review>(
  {
    learner_id: { type: Schema.Types.ObjectId, ref: "User", required: true },
    org_id: { type: Schema.Types.ObjectId, ref: "Organisation", required: true },
    level_completed: { type: String, required: true }, // e1/e2/e3/l1/l2
    stage3_objectives: { type: Schema.Types.Mixed, default: [] },
    learner_self_assessment: { type: Schema.Types.Mixed, default: null },
    ai_tutor_summary: { type: Schema.Types.Mixed, default: null },
    org_admin_confirmed_at: { type: Date, default: null },
    next_steps: { type: String, default: null },
  },
  {
    timestamps: true,
    versionKey: false,
    toJSON: {
      transform(_doc, ret) {
        delete ret.__v;
      },
    },
  }
);

stage5ReviewSchema.index({ learner_id: 1, createdAt: -1 });
stage5ReviewSchema.index({ org_id: 1, org_admin_confirmed_at: 1 });

const Stage5Review = model<IStage5Review>("Stage5Review", stage5ReviewSchema);

export default Stage5Review;
