import mongoose, { Schema, Document } from "mongoose";

/**
 * SafeguardingKeyword — per-language detection patterns.
 *
 * Each document is one keyword/phrase/regex source that the safeguarding
 * detector matches against learner messages before sending them to Gemini.
 *
 * The `pattern` field can be:
 *   - A plain phrase: case-insensitive substring match (e.g. "want to die")
 *   - A regex source delimited by /.../[flags]: compiled as a RegExp
 *     (e.g. `/\\b(?:cut|hurt)\\s+myself\\b/i`)
 *
 * Storing patterns rather than slugs lets Joey + the safeguarding
 * professional iterate without engineering involvement — they edit Mongo
 * documents (or upload a CSV) and re-run loadAll() to refresh the cache.
 *
 * Severity affects ordering when multiple patterns match: `high` fires
 * first, then `medium`, then `low`. The first match wins — we never want
 * to compile a "least severe interpretation" of an ambiguous disclosure.
 */

export type SafeguardingCategory =
  | "self_harm"
  | "domestic_abuse"
  | "radicalisation"
  | "child_concern"
  | "exploitation"
  | "mental_health_crisis";

export type SafeguardingSeverity = "low" | "medium" | "high";

export interface ISafeguardingKeyword extends Document {
  language: string;           // ISO-ish: "en", "ar", "so", "fa-AF", "ps", "zh-HK"
  pattern: string;
  category: SafeguardingCategory;
  severity: SafeguardingSeverity;
  active: boolean;
  notes?: string;
}

const safeguardingKeywordSchema = new Schema<ISafeguardingKeyword>(
  {
    language: { type: String, required: true, index: true, lowercase: true, trim: true },
    pattern: { type: String, required: true, trim: true },
    category: {
      type: String,
      required: true,
      enum: [
        "self_harm",
        "domestic_abuse",
        "radicalisation",
        "child_concern",
        "exploitation",
        "mental_health_crisis",
      ],
    },
    severity: {
      type: String,
      required: true,
      enum: ["low", "medium", "high"],
      default: "medium",
    },
    active: { type: Boolean, required: true, default: true, index: true },
    notes: { type: String, default: "" },
  },
  { collection: "safeguarding_keywords", timestamps: true, versionKey: false }
);

safeguardingKeywordSchema.index({ language: 1, active: 1 });

const SafeguardingKeyword = mongoose.model<ISafeguardingKeyword>(
  "SafeguardingKeyword",
  safeguardingKeywordSchema
);

export default SafeguardingKeyword;
