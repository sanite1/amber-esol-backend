import { Schema, model } from "mongoose";
import { IAISession } from "../interfaces/aiSession.interface";

const turnSchema = new Schema(
  {
    turnIndex: { type: Number, required: true },
    originalInput: { type: String, required: true },
    scrubbed: { type: Boolean, default: false },
    deepSeekResponse: { type: String, required: true },
    claudeAssessment: { type: String },
    safeguardingScore: { type: Number, min: 0, max: 1 },
    timestamp: { type: Date, required: true, default: Date.now },
  },
  { _id: false },
);

const aiSessionSchema = new Schema<IAISession>(
  {
    learnerId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    // teacherId + esolLevel were `required: true` pre-Function-5. Pre-platform
    // imports have no teacher and no level snapshot at the time of the
    // historical session, so both are now optional. AI tutor + consolidation
    // flows continue to populate them on every write.
    teacherId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    orgId: { type: Schema.Types.ObjectId, ref: "Organisation", required: true },
    bookingId: { type: Schema.Types.ObjectId, ref: "Booking", default: null },
    sessionMode: {
      type: String,
      enum: ["BRIDGE", "ANCHOR", "IMMERSION"],
      default: "BRIDGE",
    },
    esolLevel: { type: String, default: null },
    topic: { type: String },
    turns: { type: [turnSchema], default: [] },
    safeguardingFlagged: { type: Boolean, default: false },
    safeguardingAlertId: {
      type: Schema.Types.ObjectId,
      ref: "SafeguardingAlert",
      default: null,
    },
    assessmentSummary: { type: String },
    vocabIntroduced: { type: [String], default: [] },
    completedAt: { type: Date, default: null },

    // ── Brief Function 5 additions ───────────────────────────────────
    session_source: {
      type: String,
      enum: ["ai_tutor", "teacher_consolidation", "pre_platform"],
      default: "ai_tutor",
    },
    duration_mins: { type: Number, default: null },
    skill_codes_covered: { type: [String], default: [] },
    // scenario_id is Mixed because live AI sessions reference a scenario
    // document by ObjectId, but pre-platform imports never have one.
    // Mongoose Mixed lets the field hold either ObjectId or null.
    scenario_id: { type: Schema.Types.Mixed, default: null },
    final_score: { type: Number, default: null },
    passed: { type: Boolean, default: null },

    // ── Brief Function 7 To-Do 5 additions ──────────────────────────
    // Per-turn rolling state populated by aiSession.service.ts.
    //
    //   turn_scores[i]            = output.turn_score for turn i
    //   teaching_mode_sequence[i] = output.mode (lowercase) for turn i
    //
    // The session-level `sessionMode` (uppercase) tracks the CURRENT
    // mode for ACL / UI; `teaching_mode_sequence` is the full history.
    turn_scores: { type: [Number], default: [] },
    teaching_mode_sequence: { type: [String], default: [] },

    // ── Brief Function 7 To-Do 6 additions ──────────────────────────
    /**
     * Stage 3 objective IDs this session is collecting evidence
     * against. Matched at session start from the learner's
     * `stage3_objectives` filtered to the scenario's
     * `stage3_objective_domains`. Stable for the lifetime of the
     * session — a learner's objectives can change between sessions
     * but this snapshot is what the Stage 4 evidence rollup uses.
     */
    stage3_objective_ids: { type: [String], default: [] },
    /** Snapshot of esol_aim_type at session start — needed because
     *  the green-light validator and AddHours claim decision read
     *  the level + aim at the time of the session, not at export
     *  time. */
    esol_aim_type_at_start: {
      type: String,
      enum: ["regulated", "non_regulated", null],
      default: null,
    },
    /**
     * The aim type carried at SESSION-END (brief Function 8 To-Do 2).
     * Re-confirmed from the learner's User record by persistSessionOnEnd
     * so a change between start and end (or a start-time gap) lands as
     * the end-time value. Defaults to "non_regulated" if User.esol_aim_type
     * is missing — non_regulated suppresses AddHours in the ILR export,
     * which is the safer failure mode.
     */
    esol_aim_type: {
      type: String,
      enum: ["regulated", "non_regulated", null],
      default: null,
    },
    /** Snapshot of esolLevel at session start (immutable per session
     *  even if the learner progresses mid-cohort). */
    nqf_level_at_start: { type: String, default: null },
    start_time: { type: Date, default: null },
    end_time: { type: Date, default: null },

    // ── Brief F25 — three-beat scenario engine ───────────────────────
    // The arc the learner is on: PREPARE (lead-in) → ROLEPLAY (four
    // micro-stages = four progress dots) → COMPLETE (closing + chime).
    // Driven by `microStageComplete` / `session_complete` from the
    // validated Gemini turn; see sessionBeat.service.ts. No gating — a
    // weak attempt advances with a recast; only completion fills all dots.
    beat: {
      type: String,
      enum: ["prepare", "roleplay", "complete"],
      default: "prepare",
    },
    /** Index of the micro-stage currently in play (0..3). */
    micro_stage_index: { type: Number, default: 0 },
    /** One flag per progress dot; true once that micro-stage is done. */
    micro_stages_completed: {
      type: [Boolean],
      default: () => [false, false, false, false],
    },
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

aiSessionSchema.index({ learnerId: 1, createdAt: -1 });
aiSessionSchema.index({ orgId: 1, createdAt: -1 });
aiSessionSchema.index({ bookingId: 1 });
// Cheap filter for ILR aggregators: "all historical pre-platform GLH
// for this org over the academic year".
aiSessionSchema.index({ orgId: 1, session_source: 1, createdAt: -1 });

const AISession = model<IAISession>("AISession", aiSessionSchema);

export default AISession;
