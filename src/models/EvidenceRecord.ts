import { Schema, model, Types, Document } from "mongoose";

/**
 * EvidenceRecord — the structured, capture-time evidence chain
 * (AI Tutor Build Brief F29 / ESOL Framework §5).
 *
 * One row per (session, beat, data_point). Each row maps a concrete
 * data point produced during a session to the ILR fields it helps
 * populate and the RARPA stage it satisfies, per
 * `src/data/curriculum/evidence_mapping.json`. Rows are written AT
 * CAPTURE TIME (as the turn / session event happens), not reconstructed
 * at report time — that's what makes the chain audit-defensible: an
 * Ofsted or ASF reviewer can trace any ILR field back to the moment its
 * evidence was generated.
 *
 * THE HONESTY GATE lives in two fields:
 *   - `human_confirm`   — does this data point REQUIRE human
 *                         confirmation to count as summative evidence?
 *                         (copied from evidence_mapping.json — true for
 *                         turn_score, summative_review, etc.)
 *   - `human_confirmed` — HAS a human confirmed it yet? Defaults false.
 *                         AI judgements land as formative evidence
 *                         (human_confirmed=false); the Stage 5 human
 *                         sign-off flips this. The ILR export must never
 *                         treat a `human_confirm=true && human_confirmed=false`
 *                         record as achieved (enforced in ilrExport).
 *
 * APPEND-ONLY: the capture fields are immutable. The only mutation ever
 * applied is the human-confirmation flip (human_confirmed / _by / _at).
 */

export type EvidenceBeat =
  | "pre_session"
  | "beat_1_prepare"
  | "beat_2_roleplay"
  | "beat_3_complete"
  | "review_point";

export interface IEvidenceRecord extends Document {
  learnerId: Types.ObjectId;
  orgId: Types.ObjectId | null;
  sessionId: Types.ObjectId | null;
  beat: EvidenceBeat;
  /** The mapped data point, e.g. "turn_score", "session_summary". */
  data_point: string;
  /** ILR fields this data point contributes to (may be empty). */
  ilr_fields: string[];
  /** RARPA stage this data point satisfies. */
  rarpa_stage: string;
  /** Does this require human confirmation to be summative? (from mapping) */
  human_confirm: boolean;
  /** Has a human confirmed it? Formative until true. */
  human_confirmed: boolean;
  human_confirmed_by: Types.ObjectId | null;
  human_confirmed_at: Date | null;
  /** The captured value — shape varies by data_point. */
  value: unknown;
  /** Turn index for beat_2_roleplay rows; null otherwise. */
  turnIndex: number | null;
  /** evidence_mapping.json version (its meta.date) at capture time. */
  mapping_version: string | null;
  captured_at: Date;
}

const evidenceRecordSchema = new Schema<IEvidenceRecord>(
  {
    learnerId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      immutable: true,
      index: true,
    },
    orgId: {
      type: Schema.Types.ObjectId,
      ref: "Organisation",
      default: null,
      immutable: true,
    },
    sessionId: {
      type: Schema.Types.ObjectId,
      ref: "AISession",
      default: null,
      immutable: true,
      index: true,
    },
    beat: {
      type: String,
      enum: [
        "pre_session",
        "beat_1_prepare",
        "beat_2_roleplay",
        "beat_3_complete",
        "review_point",
      ],
      required: true,
      immutable: true,
    },
    data_point: { type: String, required: true, immutable: true },
    ilr_fields: { type: [String], default: [], immutable: true },
    rarpa_stage: { type: String, default: "", immutable: true },
    human_confirm: { type: Boolean, required: true, immutable: true },
    // The only mutable fields — the human-confirmation flip.
    human_confirmed: { type: Boolean, default: false },
    human_confirmed_by: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    human_confirmed_at: { type: Date, default: null },
    value: { type: Schema.Types.Mixed, default: null, immutable: true },
    turnIndex: { type: Number, default: null, immutable: true },
    mapping_version: { type: String, default: null, immutable: true },
    captured_at: {
      type: Date,
      required: true,
      default: Date.now,
      immutable: true,
    },
  },
  { timestamps: true, collection: "evidence_records" },
);

// The RARPA folder read: every evidence row for a learner, grouped by
// beat / stage. The session read: the full chain for one session.
evidenceRecordSchema.index({ learnerId: 1, captured_at: 1 });
evidenceRecordSchema.index({ sessionId: 1, beat: 1 });
// Idempotency guard: one row per (session, beat, data_point, turn).
// Lets the capture path upsert safely if a turn is reprocessed.
evidenceRecordSchema.index(
  { sessionId: 1, beat: 1, data_point: 1, turnIndex: 1 },
  { unique: true, sparse: true },
);

const EvidenceRecord = model<IEvidenceRecord>(
  "EvidenceRecord",
  evidenceRecordSchema,
);

export default EvidenceRecord;
