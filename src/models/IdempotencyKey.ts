import { Schema, model } from "mongoose";
import { IIdempotencyKey } from "../interfaces/idempotencyKey.interface";

/**
 * IdempotencyKey — "have we already done this operation?"
 *
 * Inserted by services BEFORE they perform a destructive or expensive
 * operation. The unique index on `key` is the lock; if a second request
 * with the same key arrives, the insert fails and the caller knows to
 * return the cached `result` instead of re-running the work.
 *
 * Used for:
 *   - ILR export generation (key = `ilr-export:<org>:<period>`)
 *   - RARPA evidence compilation
 *   - MIS push (idempotent against the MIS API too)
 *   - Delta sync
 *   - Session writes (key = `session-write:<session-id>:<turn-n>`) to
 *     stop the AI tutor from double-charging a turn if the client retries
 *
 * TTL: 90 days (7,776,000 seconds). After that the key expires and the
 * same operation can be re-attempted — covers most "can this user
 * legitimately retry?" windows while keeping the collection bounded.
 */

const idempotencyKeySchema = new Schema<IIdempotencyKey>(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    operation: {
      type: String,
      enum: [
        "ilr-export",
        "rarpa-evidence",
        "mis-push",
        "delta-sync",
        "session-write",
        "placement-scoring",
        "stage5-review",
        "invoice-generation",
      ],
      required: true,
    },
    status: {
      type: String,
      enum: ["processing", "completed", "failed"],
      required: true,
      default: "processing",
    },
    result: {
      type: Schema.Types.Mixed,
      default: null,
    },
    error: {
      type: String,
      default: null,
    },
    org_id: {
      type: Schema.Types.ObjectId,
      ref: "Organisation",
      default: null,
    },
    learner_id: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    created_at: {
      type: Date,
      required: true,
      default: Date.now,
    },
  },
  {
    versionKey: false,
    timestamps: { createdAt: false, updatedAt: false },
    toJSON: {
      transform(_doc, ret) {
        delete ret.__v;
      },
    },
  }
);

// TTL index: Mongo automatically deletes documents 90 days after created_at.
idempotencyKeySchema.index({ created_at: 1 }, { expireAfterSeconds: 7_776_000 });

// Scoped lookups, e.g. "all completed exports this month for this org".
idempotencyKeySchema.index({ org_id: 1, operation: 1, created_at: -1 });

const IdempotencyKey = model<IIdempotencyKey>(
  "IdempotencyKey",
  idempotencyKeySchema
);

export default IdempotencyKey;
