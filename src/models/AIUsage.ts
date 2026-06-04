import { Schema, model } from "mongoose";
import { IAIUsage } from "../interfaces/aiUsage.interface";

/**
 * AIUsage — append-only Gemini-call ledger.
 *
 * Writes happen from gemini.service.ts on every successful call. Failed
 * calls are not written (we don't bill for failures). Retries are
 * recorded as a single row with `retried: true`, not two rows.
 *
 * Compound index supports the dominant read shapes:
 *   { org_id, timestamp }   — "this org's usage over time"
 *   { learner_id, timestamp } — "this learner's usage over time"
 *
 * No TTL: the ledger needs to survive at least the funding year for
 * the org admin's invoice-reconciliation evidence (DPIA-2 retention
 * window is 7 years from session date).
 */
const aiUsageSchema = new Schema<IAIUsage>(
  {
    org_id: {
      type: Schema.Types.ObjectId,
      ref: "Organisation",
      default: null,
      index: true,
    },
    learner_id: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    // session_id is Mixed because some Gemini calls (placement scoring,
    // health probes) aren't bound to an AISession document — they pass
    // a string identifier or null.
    session_id: { type: Schema.Types.Mixed, default: null },
    input_tokens: { type: Number, required: true, default: 0 },
    output_tokens: { type: Number, required: true, default: 0 },
    cached_tokens: { type: Number, required: true, default: 0 },
    // See interface comment — renamed from `model` to dodge Mongoose's
    // Document.model() method conflict.
    model_name: { type: String, required: true },
    latency_ms: { type: Number, required: true },
    retried: { type: Boolean, required: true, default: false },
    timestamp: { type: Date, required: true, default: Date.now, index: true },
  },
  {
    versionKey: false,
    timestamps: { createdAt: false, updatedAt: false },
    toJSON: { transform(_doc, ret) { delete ret.__v; } },
  }
);

// Aggregation read shapes
aiUsageSchema.index({ org_id: 1, timestamp: -1 });
aiUsageSchema.index({ learner_id: 1, timestamp: -1 });

// Append-only enforcement (same pattern as AuditLog and CalibrationLog).
const blockMutation = function (next: (err?: Error) => void) {
  next(
    new Error(
      "AIUsage is append-only — updates and deletes are not permitted."
    )
  );
};
aiUsageSchema.pre(
  ["updateOne", "findOneAndUpdate", "updateMany"] as any,
  blockMutation
);
aiUsageSchema.pre(
  ["deleteOne", "findOneAndDelete", "deleteMany"] as any,
  blockMutation
);
aiUsageSchema.pre("save", function (next) {
  if (!this.isNew) {
    return next(
      new Error("AIUsage is append-only — re-saving an existing document is not permitted.")
    );
  }
  next();
});

const AIUsage = model<IAIUsage>("AIUsage", aiUsageSchema);

export default AIUsage;
