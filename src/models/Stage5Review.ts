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
    org_id: {
      type: Schema.Types.ObjectId,
      ref: "Organisation",
      required: true,
    },
    level_completed: { type: String, required: true }, // e1/e2/e3/l1/l2
    stage3_objectives: { type: Schema.Types.Mixed, default: [] },
    learner_self_assessment: { type: Schema.Types.Mixed, default: null },
    ai_tutor_summary: { type: Schema.Types.Mixed, default: null },
    org_admin_confirmed_at: { type: Date, default: null },
    // Function 17 — who signed off (org admin user id). Captured at
    // confirm time so the review detail can render "Confirmed by
    // Sarah Chen" without joining the AuditLog.
    org_admin_confirmed_by: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    next_steps: { type: String, default: null },
    // Function 17 — optional org-admin override recorded at confirm
    // time. The level change has already happened (Amber admin
    // confirmed it before the Stage 5 review opened); this is the
    // org admin's documented final decision. Stored as a string
    // ("e1"|"e2"|"e3"|"l1"|"l2"); does NOT trigger another
    // LevelChange row.
    org_admin_advance_to_level: { type: String, default: null },
    // Final Addendum §9, Todo 22.7 — teacher's pedagogical sign-off.
    // Precedes the org admin's compliance confirmation; both must
    // happen before the review is fully closed. The pair (timestamp
    // + teacher id) keeps the audit story complete without joining
    // the AuditLog row, mirroring the org_admin_confirmed_at /
    // org_admin_confirmed_by pattern above.
    teacher_signed_off_at: { type: Date, default: null },
    teacher_id: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  {
    timestamps: true,
    versionKey: false,
    toJSON: {
      transform(_doc, ret) {
        delete ret.__v;
      },
    },
  },
);

stage5ReviewSchema.index({ learner_id: 1, createdAt: -1 });
stage5ReviewSchema.index({ org_id: 1, org_admin_confirmed_at: 1 });
// Final Addendum §9 — teacher dashboard query: "what Stage 5 reviews
// are pending my sign-off?" Filters on assigned-learner subset
// (handled at the service layer) AND teacher_signed_off_at: null.
stage5ReviewSchema.index({ teacher_id: 1, teacher_signed_off_at: 1 });

const Stage5Review = model<IStage5Review>("Stage5Review", stage5ReviewSchema);

export default Stage5Review;
