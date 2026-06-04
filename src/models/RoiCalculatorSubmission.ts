import { Schema, model } from "mongoose";
import { IRoiCalculatorSubmission } from "../interfaces/roiCalculatorSubmission.interface";

/**
 * RoiCalculatorSubmission — Final Addendum §13.
 *
 * Public-funnel lead capture. Append-only by convention (no
 * UI to edit a submission); the schema doesn't enforce the
 * append-only constraint at the hook level because a submission
 * isn't compliance-relevant in the way TeacherReview /
 * LevelChange / AuditLog are. If a future ops process needs
 * to flag rows as "followed up" or "spam", that's a per-row
 * status flag added later — not a model-locked invariant.
 *
 * No PII in the indexed columns. The two indexes serve:
 *   1. `submitted_at: -1` — ops backlog ("what came in this
 *      week?")
 *   2. `ip_address_hash + submitted_at` — rate-limiting
 *      forensics ("did this IP burst the cap before we
 *      tightened the limiter?"). The hash is the safe
 *      identifier; raw IP never lands.
 */

const roiCalculatorSubmissionSchema = new Schema<IRoiCalculatorSubmission>(
  {
    waiting_list_size: { type: Number, required: true, min: 1 },
    avg_asf_rate: { type: Number, required: true, min: 1 },
    org_name: { type: String, default: null, trim: true, maxlength: 120 },
    org_type: {
      type: String,
      enum: ["college", "council", "charity", "employer", null],
      default: null,
    },
    current_throughput_per_year: { type: Number, default: 0, min: 0 },

    contact_email: {
      type: String,
      default: null,
      lowercase: true,
      trim: true,
      maxlength: 254,
    },
    contact_name: {
      type: String,
      default: null,
      trim: true,
      maxlength: 120,
    },

    // Computed snapshot — what the prospect actually saw.
    unclaimed_income_annual: { type: Number, required: true, min: 0 },
    payback_weeks: { type: Number, default: null },

    // Request metadata — SHA-256(ip + salt), never the raw IP.
    ip_address_hash: { type: String, required: true, index: true },
    user_agent: { type: String, default: null, maxlength: 500 },

    submitted_at: {
      type: Date,
      required: true,
      default: Date.now,
      index: true,
    },

    // Final Addendum §13 — sales follow-up tracking. Set once
    // via the admin mark-contacted endpoint; never cleared
    // (a row already followed-up shouldn't bounce back into
    // the outstanding-leads backlog).
    contacted_at: { type: Date, default: null },
    contacted_by: {
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
        // Never echo the IP hash in API responses. The dashboard
        // ops view (future) reads via a separate admin endpoint
        // that can opt-in.
        delete ret.ip_address_hash;
      },
    },
  },
);

// Ops backlog scan — "give me this week's submissions".
roiCalculatorSubmissionSchema.index({ submitted_at: -1 });
// Rate-limit forensics — "show me everything from this hash window".
roiCalculatorSubmissionSchema.index({ ip_address_hash: 1, submitted_at: -1 });
// Final Addendum §13 — admin sales-intel "outstanding leads"
// view: filter on contacted=false, sort by submitted_at desc.
// Partial-index optimisation skipped: the cohort is small
// (<100k rows for years) and Mongo's planner picks the simple
// compound just fine.
roiCalculatorSubmissionSchema.index({ contacted_at: 1, submitted_at: -1 });

const RoiCalculatorSubmission = model<IRoiCalculatorSubmission>(
  "RoiCalculatorSubmission",
  roiCalculatorSubmissionSchema,
);

export default RoiCalculatorSubmission;
