import { Schema, model } from "mongoose";
import { ITeacherReview } from "../interfaces/teacherReview.interface";

/**
 * TeacherReview — APPEND-ONLY log of every teacher touch-point on a learner.
 *
 * Every row is a discrete teacher action that consumes part of their weekly
 * touch-point quota under the teacher-multiplier model (addendum §4).
 * The four review_type values map to RARPA / contact-hour categories that
 * roll up into ILR and inspection reports.
 *
 * Immutability is enforced at three layers:
 *   1. App layer: pre-save hook rejects re-saves of existing docs
 *   2. Query layer: pre-update / pre-delete hooks throw
 *   3. (Reader's eye): no updatedAt timestamp in the schema config
 *
 * The brief mandates org_id on every document because every query for
 * reviews is org-scoped — even "show me what teacher X did" must be
 * bounded by the teacher's org to satisfy cross-org isolation.
 */

const teacherReviewSchema = new Schema<ITeacherReview>(
  {
    learner_id: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    teacher_id: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    org_id: {
      type: Schema.Types.ObjectId,
      ref: "Organisation",
      required: true,
    },
    review_type: {
      type: String,
      enum: [
        "async_review",        // teacher read AI output without contacting learner
        "contact_session",     // synchronous teacher–learner session
        "pathway_adjustment",  // teacher overrode/added scenarios for this learner
        "rarpa_signoff",       // teacher confirmed a RARPA stage advancement
      ],
      required: true,
    },
    duration_mins: {
      type: Number,
      required: true,
      min: 0,
    },
    notes: {
      type: String,
      maxlength: 500,
      default: "",
      trim: true,
    },
    ai_recommendation_acted_on: {
      type: Boolean,
      required: true,
      default: false,
    },
    // created_at is set explicitly (not via timestamps) so it can be
    // indexed and back-dated for migrations. Default is current time.
    created_at: {
      type: Date,
      required: true,
      default: Date.now,
      index: true,
    },
  },
  {
    // No timestamps option — we manage created_at explicitly and there
    // is no updatedAt because rows never change after creation.
    versionKey: false,
    toJSON: {
      transform(_doc, ret) {
        delete ret.__v;
      },
    },
  }
);

// Per-org dashboard: "all teacher activity in this org over time"
teacherReviewSchema.index({ org_id: 1, created_at: -1 });

// Per-learner history: "what touch-points has this learner had?"
teacherReviewSchema.index({ learner_id: 1, created_at: -1 });

// ── Append-only enforcement ────────────────────────────────────────────
const blockMutation = function (next: (err?: Error) => void) {
  next(
    new Error("TeacherReview is append-only — updates and deletes are not permitted.")
  );
};

teacherReviewSchema.pre(
  ["updateOne", "findOneAndUpdate", "updateMany"] as any,
  blockMutation
);
teacherReviewSchema.pre(
  ["deleteOne", "findOneAndDelete", "deleteMany"] as any,
  blockMutation
);
teacherReviewSchema.pre("save", function (next) {
  if (!this.isNew) {
    return next(
      new Error("TeacherReview is append-only — re-saving an existing document is not permitted.")
    );
  }
  next();
});

const TeacherReview = model<ITeacherReview>("TeacherReview", teacherReviewSchema);

export default TeacherReview;
