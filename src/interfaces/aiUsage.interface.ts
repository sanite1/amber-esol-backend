import { Types, Document } from "mongoose";

/**
 * One row per Gemini call — brief Function 9 cost-tracking requirement.
 *
 * Feeds:
 *   - Billing reconciliation (Function 14): "How many tokens did this
 *     org consume in October?" — sum by org_id + month.
 *   - Per-learner usage report on the dashboard: "This learner has
 *     used X turns this week."
 *   - Anomaly detection: a learner whose token count spikes 10× over
 *     their baseline is either being abused or abusing.
 *
 * Append-only. Never aggregated in place; aggregations happen at
 * read time via `$group` queries.
 */
export interface IAIUsage extends Document {
  _id: Types.ObjectId;
  org_id: Types.ObjectId | null; // null for system probes (e.g. health check)
  learner_id: Types.ObjectId | null;
  session_id: Types.ObjectId | string | null;
  /** Input tokens (prompt + system instruction + history). */
  input_tokens: number;
  /** Output tokens (the model's response). */
  output_tokens: number;
  /** Tokens served from Vertex's prompt cache, if any. Subset of input_tokens. */
  cached_tokens: number;
  // Field renamed from the brief's `model` to `model_name` because
  // `model` is a reserved method name on Mongoose's Document type and
  // overrides it as a string property — TypeScript rejects the
  // collision. On-disk concept is identical; aggregation queries
  // reference `model_name`.
  model_name: string; // e.g. "gemini-2.5-flash"
  /** Wall-clock latency in milliseconds, including retries. */
  latency_ms: number;
  /** Whether at least one retry fired for this call. */
  retried: boolean;
  timestamp: Date;
}
