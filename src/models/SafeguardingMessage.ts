import { Schema, model } from "mongoose";

/**
 * Safeguarding response text — Final Addendum §2.
 *
 * One document per (category, language). The brief: "Pre-written
 * response text per language per disclosure category stored in
 * MongoDB, loaded into memory at startup, updated via Amber admin
 * CMS — reloads without deployment."
 *
 * The in-memory bank in safeguardingMessages.service.ts is rebuilt
 * from this collection at boot and after every admin edit. The static
 * JSON file (src/data/safeguarding-messages.json) remains as the
 * first-boot seed and the fail-safe if Mongo is unreachable.
 *
 * `text` may legitimately be "" — an empty translation falls back to
 * English at lookup time (the service's existing fall-back chain).
 */

export interface ISafeguardingMessage {
  category:
    | "self_harm"
    | "domestic_abuse"
    | "radicalisation"
    | "child_concern"
    | "exploitation"
    | "mental_health_crisis";
  language: "en" | "ar" | "so" | "fa" | "zh";
  text: string;
  updated_by: Schema.Types.ObjectId | null;
  updated_at: Date;
}

const safeguardingMessageSchema = new Schema<ISafeguardingMessage>(
  {
    category: {
      type: String,
      enum: [
        "self_harm",
        "domestic_abuse",
        "radicalisation",
        "child_concern",
        "exploitation",
        "mental_health_crisis",
      ],
      required: true,
    },
    language: {
      type: String,
      enum: ["en", "ar", "so", "fa", "zh"],
      required: true,
    },
    text: { type: String, default: "", maxlength: 2000 },
    updated_by: { type: Schema.Types.ObjectId, ref: "User", default: null },
    updated_at: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

safeguardingMessageSchema.index({ category: 1, language: 1 }, { unique: true });

const SafeguardingMessage = model<ISafeguardingMessage>(
  "SafeguardingMessage",
  safeguardingMessageSchema,
);

export default SafeguardingMessage;
