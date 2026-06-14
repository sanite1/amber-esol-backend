import mongoose, { Schema, Document } from "mongoose";

/**
 * Persistent record of a BullMQ job that exhausted all retries.
 *
 * BullMQ keeps a bounded ring of failed jobs in Redis (see removeOnFail on
 * each queue), but Redis is volatile and Upstash plans evict old data. This
 * collection is the durable audit trail — every terminal failure across every
 * queue is written here so we can investigate, reprocess, or surface in the
 * Amber admin dashboard.
 *
 * Indexed on created_at descending so "most recent failures" queries are fast.
 * Indexed on queue_name + created_at so per-queue dashboards stay snappy.
 */

export interface IFailedJob extends Document {
  queue_name: string;
  job_id: string;
  job_data: unknown;
  error: string;
  attempts: number;
  created_at: Date;
  /**
   * Set when an admin re-enqueues this failed job via the review
   * dashboard. Non-null `retried_at` means "this row has been
   * actioned" — useful filter for the unresolved-failures count.
   */
  retried_at: Date | null;
  /**
   * Soft-delete flag. Final Addendum §1 — dismissing a failure
   * doesn't remove the row (audit needs it), it just hides it from
   * the default listing and the sidebar badge.
   */
  dismissed: boolean;
  /**
   * Who dismissed it (Amber admin id). Null until dismissed.
   */
  dismissed_by: mongoose.Types.ObjectId | null;
  dismissed_at: Date | null;
}

const failedJobSchema = new Schema<IFailedJob>(
  {
    queue_name: { type: String, required: true, index: true },
    job_id: { type: String, required: true },
    job_data: { type: Schema.Types.Mixed },
    error: { type: String, required: true },
    attempts: { type: Number, required: true, default: 0 },
    created_at: { type: Date, default: Date.now, index: true },
    retried_at: { type: Date, default: null },
    dismissed: { type: Boolean, default: false, index: true },
    dismissed_by: { type: Schema.Types.ObjectId, ref: "User", default: null },
    dismissed_at: { type: Date, default: null },
  },
  { collection: "failed_jobs", versionKey: false },
);

// Compound index for the dashboard's "failures in queue X this week" query.
failedJobSchema.index({ queue_name: 1, created_at: -1 });
// "Unresolved failures" — used by the count endpoint that powers the
// sidebar badge. Covers `{ dismissed: false }` queries fast.
failedJobSchema.index({ dismissed: 1, created_at: -1 });

const FailedJob = mongoose.model<IFailedJob>("FailedJob", failedJobSchema);
export default FailedJob;
