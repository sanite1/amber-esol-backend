import { Schema, model } from "mongoose";
import { ISafeguardingAlert } from "../interfaces/safeguardingAlert.interface";

const safeguardingAlertSchema = new Schema<ISafeguardingAlert>(
  {
    // ── Immutable disclosure core (F22) ───────────────────────────
    // These describe WHAT was disclosed and are append-only: once the
    // alert exists they can never change. `immutable: true` makes
    // Mongoose silently ignore any update to them. Only the review /
    // status lifecycle fields further down are mutable.
    learnerId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      immutable: true,
    },
    orgId: {
      type: Schema.Types.ObjectId,
      ref: "Organisation",
      required: true,
      immutable: true,
    },
    sessionId: {
      type: Schema.Types.ObjectId,
      ref: "AISession",
      required: true,
      immutable: true,
    },
    alertLevel: {
      type: String,
      enum: ["low", "medium", "high", "critical"],
      required: true,
      immutable: true,
    },
    /**
     * SHA-256 hex of the original learner message. Lets a reviewer
     * correlate alert → TurnLog without duplicating content. Immutable.
     */
    messageContentHash: {
      type: String,
      required: true,
      immutable: true,
      match: [
        /^[0-9a-f]{64}$/,
        "messageContentHash must be a 64-char lower-hex SHA-256 digest",
      ],
    },
    /**
     * Raw disclosure text, ENCRYPTED at rest (safeguardingCrypto). NOT
     * cleartext — decrypt only on an authorised DSL read. Null when no
     * encryption key is configured (raw then stays in TurnLog) or on
     * the ai_only path. Immutable once written.
     */
    rawInputEncrypted: {
      type: String,
      default: null,
      immutable: true,
    },
    triggerCategory: {
      type: String,
      enum: [
        "self_harm",
        "domestic_abuse",
        "radicalisation",
        "child_concern",
        "child_protection", // legacy Gemini enum — accepted until naming reconciliation lands
        "exploitation",
        "mental_health_crisis",
      ],
      default: null,
      immutable: true,
    },
    triggerSource: {
      type: String,
      enum: ["keyword", "ai_only"],
      default: null,
      immutable: true,
    },
    claudeReasoning: { type: String },
    reviewedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    reviewedAt: { type: Date, default: null },
    status: {
      type: String,
      enum: ["open", "reviewed", "escalated", "resolved", "dismissed"],
      default: "open",
    },
    resolution: { type: String },
    // Brief Function 10/15 admin-resolution lifecycle. Distinct from
    // `reviewedAt` / `reviewedBy` (which mark "an admin looked at it")
    // — these mark the terminal "this has been actioned with notes".
    // PATCH /api/admin/safeguarding/:id sets all three atomically.
    resolvedAt: { type: Date, default: null },
    resolvedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    resolutionNotes: { type: String, default: null },
    notificationSentAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret) {
        delete ret.__v;
      },
    },
  },
);

safeguardingAlertSchema.index({ orgId: 1, status: 1 });
safeguardingAlertSchema.index({ learnerId: 1 });
safeguardingAlertSchema.index({ alertLevel: 1, status: 1 });
// Admin list page sorts by triggered_at desc with optional resolved
// filter — covered by the resolvedAt + createdAt compound index.
safeguardingAlertSchema.index({ resolvedAt: 1, createdAt: -1 });
safeguardingAlertSchema.index({ triggerCategory: 1, createdAt: -1 });

const SafeguardingAlert = model<ISafeguardingAlert>(
  "SafeguardingAlert",
  safeguardingAlertSchema,
);

export default SafeguardingAlert;
