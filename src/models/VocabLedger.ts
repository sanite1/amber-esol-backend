import { Schema, model } from "mongoose";
import { IVocabLedger } from "../interfaces/vocabLedger.interface";

const vocabLedgerSchema = new Schema<IVocabLedger>(
  {
    learnerId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    // orgId / sessionId / esolLevel loosened to optional per Function 9
    // To-Do 1 — the per-turn upsert path doesn't pass them. Legacy
    // writers still set them explicitly when introducing vocab; the
    // brief's updateLedgerForTurn leaves them null.
    orgId: { type: Schema.Types.ObjectId, ref: "Organisation", default: null },
    sessionId: { type: Schema.Types.ObjectId, ref: "AISession", default: null },
    word: { type: String, required: true, trim: true },
    definition: { type: String },
    contextSentence: { type: String },
    esolLevel: { type: String, default: null },
    topic: { type: String },
    introducedAt: { type: Date, required: true, default: Date.now },
    revisedAt: { type: Date },
    masteryScore: { type: Number, min: 0, max: 1 },

    // ── Brief Function 9 To-Do 1 fields ──────────────────────────────
    /** Total encounters across all sessions. Incremented atomically. */
    times_encountered: { type: Number, default: 0 },
    /** True once times_encountered ≥ 5 AND a turn with this word
     *  scored ≥ 0.70. Sticky — once true, stays true. */
    retained: { type: Boolean, default: false },
    /** The scenario id where this word was FIRST seen. Set on insert;
     *  immutable thereafter. */
    scenario_first_seen: { type: String, default: null },
    /** The Stage 3 objective the introducing session was linked to. */
    stage3_objective_id: { type: String, default: null },
    /** Most recent encounter timestamp. */
    last_seen_at: { type: Date, default: null },
    /** English gloss for the word — populated by the future
     *  vocab-introduction worker; null until then. */
    definition_en: { type: String, default: null },
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

vocabLedgerSchema.index({ learnerId: 1, esolLevel: 1 });
// Unique per-learner+word so updateLedgerForTurn's upsert relies on
// findAndModify semantics (no duplicate rows under concurrent turns).
vocabLedgerSchema.index({ learnerId: 1, word: 1 }, { unique: true });
vocabLedgerSchema.index({ orgId: 1 });
// Reinforcement-target query — see getReinforcementTargets.
vocabLedgerSchema.index({
  learnerId: 1,
  retained: 1,
  times_encountered: 1,
  last_seen_at: 1,
});

const VocabLedger = model<IVocabLedger>("VocabLedger", vocabLedgerSchema);

export default VocabLedger;
