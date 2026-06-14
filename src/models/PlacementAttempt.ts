import { Schema, model } from "mongoose";
import { IPlacementAttempt } from "../interfaces/placementAttempt.interface";

/**
 * PlacementAttempt — one learner's run through the 20-question adaptive
 * placement (brief Function 6).
 *
 * The selected question ids are written once at start; positions 6–20
 * are rewritten at most once when the answer-5 adaptive recalc fires.
 * After that the queue is immutable until `status === "scored"`.
 *
 * No append-only enforcement at this layer — the placement service is
 * the only writer; we trust it to follow the protocol. AuditLog rows
 * give the compliance trail.
 */

const answeredQuestionSchema = new Schema(
  {
    question_id: { type: String, required: true },
    answer: { type: String, required: true },
    was_correct: { type: Boolean, required: true },
    answered_at: { type: Date, required: true, default: Date.now },
  },
  { _id: false },
);

const placementResultSchema = new Schema(
  {
    nqf_level: {
      type: String,
      enum: ["e1", "e2", "e3", "l1", "l2", null],
      default: null,
    },
    placement_confidence: { type: Number, default: null },
    skill_breakdown: { type: Schema.Types.Mixed, default: {} },
    weakness_flags: { type: [String], default: [] },
    rationale: { type: String, default: null },
  },
  { _id: false },
);

const placementAttemptSchema = new Schema<IPlacementAttempt>(
  {
    learnerId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    orgId: { type: Schema.Types.ObjectId, ref: "Organisation", required: true },
    bank_version: { type: Number, required: true },
    selected_question_ids: { type: [String], required: true },
    answers: { type: [answeredQuestionSchema], default: [] },
    status: {
      type: String,
      enum: ["in_progress", "submitted", "scored"],
      required: true,
      default: "in_progress",
    },
    recalc_applied_at: { type: Date, default: null },
    recalc_outcome: {
      type: String,
      enum: ["all_correct", "all_wrong", "mixed", null],
      default: null,
    },
    startedAt: { type: Date, required: true, default: Date.now },
    submittedAt: { type: Date, default: null },
    scoredAt: { type: Date, default: null },
    result: { type: placementResultSchema, default: null },
  },
  {
    versionKey: false,
    timestamps: { createdAt: false, updatedAt: true },
  },
);

// "Does this learner have an attempt in flight?" — the answer endpoint
// uses this to resume vs start.
placementAttemptSchema.index({ learnerId: 1, status: 1, startedAt: -1 });
// Per-org reporting — "how many learners completed placement this week?"
placementAttemptSchema.index({ orgId: 1, status: 1, scoredAt: -1 });

const PlacementAttempt = model<IPlacementAttempt>(
  "PlacementAttempt",
  placementAttemptSchema,
);

export default PlacementAttempt;
