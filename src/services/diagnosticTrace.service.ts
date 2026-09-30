import { Types } from "mongoose";
import { DiagnosticTrace } from "../models/DiagnosticTrace";
import logger from "../config/logger";

/**
 * Diagnostic tracing — Silk bug brief section 0.
 *
 * Two entry points, both fire and forget and both safe to call from a
 * hot path: they never throw and never block the caller.
 *
 *   traceGeminiCall(...)  every Gemini call: the full prompt, the raw
 *                         response, the parsed fields, temperature,
 *                         model and time taken.
 *   traceWrite(...)       every write to Stage 3 objectives, the
 *                         vocabulary ledger and session stats: the
 *                         value before and after.
 *
 * A short structured log line goes out too (lengths and a preview,
 * never the full prompt, so Render logs stay readable). The full
 * payload lives in the diagnostic_traces collection, replayable with
 * `npm run trace:session -- <sessionId>`.
 */

export type TraceId = string | Types.ObjectId | null | undefined;

export interface TraceContext {
  sessionId?: TraceId;
  learnerId?: TraceId;
  orgId?: TraceId;
}

export const traceEnabled = (): boolean =>
  (process.env.AI_TRACE_ENABLED ?? "true").toLowerCase() !== "false";

const asString = (v: TraceId): string | null => (v ? String(v) : null);
const asObjectId = (v: TraceId): Types.ObjectId | null => {
  if (!v) return null;
  if (v instanceof Types.ObjectId) return v;
  return Types.ObjectId.isValid(String(v))
    ? new Types.ObjectId(String(v))
    : null;
};

const preview = (s: string | null | undefined, n = 160): string | null =>
  typeof s === "string" ? s.replace(/\s+/g, " ").slice(0, n) : null;

/** Mongoose docs and ObjectIds become plain JSON so `before`/`after`
 *  diff cleanly in a replay. */
const plain = (v: unknown): unknown => {
  if (v === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(v));
  } catch {
    return String(v);
  }
};

export interface GeminiCallTrace extends TraceContext {
  source: string;
  modelName: string;
  temperature?: number | null;
  maxOutputTokens?: number | null;
  systemPrompt?: string | null;
  history?: Array<{ role: string; content: string }> | null;
  userMessage?: string | null;
  rawResponse?: string | null;
  parsed?: unknown;
  finishReason?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  latencyMs: number;
  error?: unknown;
}

export const traceGeminiCall = (t: GeminiCallTrace): void => {
  const errorText =
    t.error == null
      ? null
      : t.error instanceof Error
        ? `${t.error.name}: ${t.error.message}`
        : String(t.error);

  logger.info(
    {
      trace: "gemini_call",
      source: t.source,
      session_id: asString(t.sessionId),
      learner_id: asString(t.learnerId),
      model: t.modelName,
      temperature: t.temperature ?? null,
      latency_ms: t.latencyMs,
      prompt_chars: t.systemPrompt?.length ?? 0,
      history_turns: t.history?.length ?? 0,
      user_message_preview: preview(t.userMessage),
      response_chars: t.rawResponse?.length ?? 0,
      response_preview: preview(t.rawResponse),
      finish_reason: t.finishReason ?? null,
      error: errorText,
    },
    "gemini call traced",
  );

  if (!traceEnabled()) return;
  DiagnosticTrace.create({
    kind: "gemini_call",
    session_id: asString(t.sessionId),
    learner_id: asObjectId(t.learnerId),
    org_id: asObjectId(t.orgId),
    source: t.source,
    model_name: t.modelName,
    temperature: t.temperature ?? null,
    max_output_tokens: t.maxOutputTokens ?? null,
    system_prompt: t.systemPrompt ?? null,
    history: t.history ?? null,
    user_message: t.userMessage ?? null,
    raw_response: t.rawResponse ?? null,
    parsed: plain(t.parsed),
    finish_reason: t.finishReason ?? null,
    input_tokens: t.inputTokens ?? null,
    output_tokens: t.outputTokens ?? null,
    latency_ms: t.latencyMs,
    error: errorText,
    timestamp: new Date(),
  }).catch((err) =>
    logger.warn({ err, source: t.source }, "diagnostic trace write failed"),
  );
};

export interface WriteTrace extends TraceContext {
  /** e.g. "user.stage3_objectives", "vocab_ledger.word", "ai_session.turn" */
  source: string;
  collection: string;
  docId?: TraceId;
  before: unknown;
  after: unknown;
}

export const traceWrite = (t: WriteTrace): void => {
  const before = plain(t.before);
  const after = plain(t.after);
  logger.info(
    {
      trace: "data_write",
      source: t.source,
      collection: t.collection,
      doc_id: asString(t.docId),
      session_id: asString(t.sessionId),
      learner_id: asString(t.learnerId),
      before: preview(JSON.stringify(before), 300),
      after: preview(JSON.stringify(after), 300),
    },
    "data write traced",
  );

  if (!traceEnabled()) return;
  DiagnosticTrace.create({
    kind: "data_write",
    session_id: asString(t.sessionId),
    learner_id: asObjectId(t.learnerId),
    org_id: asObjectId(t.orgId),
    source: t.source,
    collection_name: t.collection,
    doc_id: asString(t.docId),
    before,
    after,
    timestamp: new Date(),
  }).catch((err) =>
    logger.warn({ err, source: t.source }, "diagnostic trace write failed"),
  );
};
