import { Schema, model } from "mongoose";
import { IIlrExportWarnings } from "../interfaces/ilrExportWarnings.interface";

/**
 * IlrExportWarnings — per-export validation warnings cache (Phase 14).
 *
 * When the ILR export validator runs, it emits a CSV plus a list of
 * non-fatal warnings (missing ULN, postcode not in DfE dataset, etc.).
 * The CSV is sent to the org admin to import; the warnings list stays
 * here for 7 days so the org admin can review which records need
 * attention before the next monthly submission.
 *
 * `export_id` is the BullMQ jobId from the cache-refresh queue or the
 * ilr-export queue — keeps the warnings linkable to the actual artefact.
 */

const ilrExportWarningsSchema = new Schema<IIlrExportWarnings>(
  {
    export_id: { type: String, required: true, index: true },
    org_id: {
      type: Schema.Types.ObjectId,
      ref: "Organisation",
      required: true,
      index: true,
    },
    warnings: {
      type: [Schema.Types.Mixed],
      default: [],
      // Each entry typically: { learnerId, field, severity, message }
    },
    created_at: { type: Date, required: true, default: Date.now },
  },
  {
    versionKey: false,
    timestamps: { createdAt: false, updatedAt: false },
    toJSON: {
      transform(_doc, ret) {
        delete ret.__v;
      },
    },
  },
);

// TTL index — 7 days (604,800 seconds). After that the org admin should
// have already actioned the warnings or re-run the export.
ilrExportWarningsSchema.index(
  { created_at: 1 },
  { expireAfterSeconds: 604_800 },
);

const IlrExportWarnings = model<IIlrExportWarnings>(
  "IlrExportWarnings",
  ilrExportWarningsSchema,
);

export default IlrExportWarnings;
