import { Schema, model } from "mongoose";

/**
 * CurriculumLevel — one document per NQF level (E1…L2).
 *
 * The machine-readable curriculum the system-prompt builder (Layer 3 /
 * Layer 5), the placement objective bank (F30), the vocab retention
 * thresholds (F27) and the Bridge-Method mode controller (F26) all
 * read from. Seeded ONCE from `src/data/curriculum/esol_curriculum.json`
 * (AI Tutor Build Brief §1.1) and **versioned, read-only at runtime** —
 * editing a level after evidence exists would invalidate that evidence,
 * so changes land as a new `version` via re-seed, never an in-place edit.
 *
 * The source JSON carries human-readable ranges ("3-5 new items",
 * "70:30 to 60:40 (L1:English)"); the seeder parses those into the
 * numeric bands stored here so the controller can compare without
 * re-parsing prose every turn.
 */

export type NqfLevel = "E1" | "E2" | "E3" | "L1" | "L2";
export type BridgeMode =
  | "ANCHOR"
  | "ANCHOR_BRIDGE"
  | "BRIDGE"
  | "BRIDGE_IMMERSION"
  | "IMMERSION";

export interface ICurriculumLevel {
  level: NqfLevel;
  cefr: string;
  canDo: {
    listening: string;
    reading: string;
    spokenInteraction: string;
    spokenProduction: string;
    writing: string;
  };
  grammarTargets: Array<{ form: string; longHorizon: boolean }>;
  /** Canonical developmentally-late forms — recycled, never failed. */
  longHorizonForms: string[];
  vocabTargetSize: { min: number; max: number };
  vocabPerSession: { min: number; max: number };
  /** L1 fraction band (0..1). 70:30 L1:English → 0.70. */
  bridgeL1Ratio: { min: number; max: number };
  mode: BridgeMode;
  anchorTriggers: string[];
  immersionTriggers: string[];
  retentionEncounters: { min: number; max: number };
  reinforcementInterval: string;
  rarpaObjectives: {
    speakingListening: string[];
    reading: string[];
    writing: string[];
  };
  source: string;
  version: string;
}

const rangeSchema = {
  min: { type: Number, required: true },
  max: { type: Number, required: true },
};

const curriculumLevelSchema = new Schema<ICurriculumLevel>(
  {
    level: {
      type: String,
      enum: ["E1", "E2", "E3", "L1", "L2"],
      required: true,
    },
    cefr: { type: String, required: true },
    canDo: {
      listening: { type: String, default: "" },
      reading: { type: String, default: "" },
      spokenInteraction: { type: String, default: "" },
      spokenProduction: { type: String, default: "" },
      writing: { type: String, default: "" },
    },
    grammarTargets: {
      type: [
        {
          form: { type: String, required: true },
          longHorizon: { type: Boolean, default: false },
        },
      ],
      default: [],
    },
    longHorizonForms: { type: [String], default: [] },
    vocabTargetSize: rangeSchema,
    vocabPerSession: rangeSchema,
    bridgeL1Ratio: rangeSchema,
    mode: {
      type: String,
      enum: [
        "ANCHOR",
        "ANCHOR_BRIDGE",
        "BRIDGE",
        "BRIDGE_IMMERSION",
        "IMMERSION",
      ],
      required: true,
    },
    anchorTriggers: { type: [String], default: [] },
    immersionTriggers: { type: [String], default: [] },
    retentionEncounters: rangeSchema,
    reinforcementInterval: { type: String, default: "" },
    rarpaObjectives: {
      speakingListening: { type: [String], default: [] },
      reading: { type: [String], default: [] },
      writing: { type: [String], default: [] },
    },
    source: { type: String, default: "esol_curriculum.json" },
    version: { type: String, required: true },
  },
  { timestamps: true },
);

// One active document per level+version; the common read is by level.
curriculumLevelSchema.index({ level: 1, version: 1 }, { unique: true });

const CurriculumLevel = model<ICurriculumLevel>(
  "CurriculumLevel",
  curriculumLevelSchema,
);

export default CurriculumLevel;
