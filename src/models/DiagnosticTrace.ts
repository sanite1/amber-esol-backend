import { Schema, model, Types } from "mongoose";

/**
 * DiagnosticTrace — Silk bug brief section 0.
 *
 * One row per Gemini call and per write to the collections whose
 * displayed numbers were found to drift (Stage 3 objectives, the
 * vocabulary ledger, per session stats on AISession). Every row is
 * keyed by session_id so a session can be replayed end to end:
 *
 *   npm run trace:session -- <sessionId>
 *
 * Append only (same enforcement as AIUsage / TurnLog). Rows expire
 * after TRACE_TTL_DAYS; they are a diagnostic aid, not the audit
 * trail (AuditLog / EvidenceRecord remain the records of truth).
 *
 * Switch off with AI_TRACE_ENABLED=false. Default on, in every
 * environment, because the whole point is to see production.
 */

export type DiagnosticTraceKind = "gemini_call" | "data_write";

export interface IDiagnosticTrace {
  kind: DiagnosticTraceKind;
  /** AISession id, placement attempt id, or null for system calls. */
  session_id: string | null;
  learner_id: Types.ObjectId | null;
  org_id: Types.ObjectId | null;
  /** Where the call or write came from, e.g. "tutor_turn",
   *  "placement_scoring", "user.stage3_objectives". */
  source: string;

  // ── gemini_call ────────────────────────────────────────────────
  model_name?: string | null;
  temperature?: number | null;
  max_output_tokens?: number | null;
  system_prompt?: string | null;
  history?: Array<{ role: string; content: string }> | null;
  user_message?: string | null;
  raw_response?: string | null;
  parsed?: unknown;
  finish_reason?: string | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  latency_ms?: number | null;
  error?: string | null;

  // ── data_write ─────────────────────────────────────────────────
  collection_name?: string | null;
  doc_id?: string | null;
  before?: unknown;
  after?: unknown;

  timestamp: Date;
}

const TRACE_TTL_DAYS = 45;

const diagnosticTraceSchema = new Schema<IDiagnosticTrace>(
  {
    kind: {
      type: String,
      enum: ["gemini_call", "data_write"],
      required: true,
    },
    session_id: { type: String, default: null, index: true },
    learner_id: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    org_id: { type: Schema.Types.ObjectId, ref: "Organisation", default: null },
    source: { type: String, required: true },

    model_name: { type: String, default: null },
    temperature: { type: Number, default: null },
    max_output_tokens: { type: Number, default: null },
    system_prompt: { type: String, default: null },
    history: { type: Schema.Types.Mixed, default: null },
    user_message: { type: String, default: null },
    raw_response: { type: String, default: null },
    parsed: { type: Schema.Types.Mixed, default: null },
    finish_reason: { type: String, default: null },
    input_tokens: { type: Number, default: null },
    output_tokens: { type: Number, default: null },
    latency_ms: { type: Number, default: null },
    error: { type: String, default: null },

    collection_name: { type: String, default: null },
    doc_id: { type: String, default: null },
    before: { type: Schema.Types.Mixed, default: null },
    after: { type: Schema.Types.Mixed, default: null },

    timestamp: { type: Date, required: true, default: Date.now },
  },
  {
    versionKey: false,
    timestamps: { createdAt: false, updatedAt: false },
    minimize: false,
  },
);

diagnosticTraceSchema.index({ session_id: 1, timestamp: 1 });
diagnosticTraceSchema.index(
  { timestamp: 1 },
  { expireAfterSeconds: TRACE_TTL_DAYS * 24 * 60 * 60 },
);

const blockMutation = function (next: (err?: Error) => void) {
  next(
    new Error(
      "DiagnosticTrace is append only — updates and deletes are not permitted.",
    ),
  );
};
diagnosticTraceSchema.pre("updateOne", blockMutation);
diagnosticTraceSchema.pre("updateMany", blockMutation);
diagnosticTraceSchema.pre("findOneAndUpdate", blockMutation);
diagnosticTraceSchema.pre("deleteOne", blockMutation);
diagnosticTraceSchema.pre("deleteMany", blockMutation);
diagnosticTraceSchema.pre("findOneAndDelete", blockMutation);

export const DiagnosticTrace = model<IDiagnosticTrace>(
  "DiagnosticTrace",
  diagnosticTraceSchema,
  "diagnostic_traces",
);

export default DiagnosticTrace;
