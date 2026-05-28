import { Schema, model } from "mongoose";
import { INarrativeCache } from "../interfaces/narrativeCache.interface";

/**
 * NarrativeCache — per-org Gemini-generated cohort narrative for the org
 * admin dashboard (Phase 13).
 *
 * Generated on-demand and cached for 24 hours via TTL index. If the cache
 * is stale or missing, the next dashboard load triggers a fresh Gemini
 * call. `metrics` snapshots the underlying numbers so the narrative and
 * its supporting data stay in sync even if the live aggregates have moved.
 */

const narrativeCacheSchema = new Schema<INarrativeCache>(
  {
    org_id: {
      type: Schema.Types.ObjectId,
      ref: "Organisation",
      required: true,
      index: true,
    },
    narrative: { type: String, required: true },
    metrics: { type: Schema.Types.Mixed, default: {} },
    generated_at: { type: Date, required: true, default: Date.now },
    expires_at: { type: Date, required: true },
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

// TTL index — Mongo deletes the row 24h (86,400s) after generated_at.
// We index on generated_at rather than expires_at to keep the field
// authoritative (expires_at is just a convenient client-readable value).
narrativeCacheSchema.index({ generated_at: 1 }, { expireAfterSeconds: 86_400 });

// One active cache per org. Old rows expire naturally; the latest is
// found by sorting on generated_at desc.
narrativeCacheSchema.index({ org_id: 1, generated_at: -1 });

const NarrativeCache = model<INarrativeCache>(
  "NarrativeCache",
  narrativeCacheSchema
);

export default NarrativeCache;
