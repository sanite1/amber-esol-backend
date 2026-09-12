import { Types } from "mongoose";

import { geminiClient, MODEL_NAME } from "../lib/gemini";
import AIUsage from "../models/AIUsage";
import {
  GeminiApiError,
  GeminiSchemaError,
  GeminiTimeoutError,
} from "../errors/geminiErrors";
import logger from "../config/logger";

/**
 * Low-level Gemini wrapper — brief Function 9.
 *
 * Sits ON TOP of the `geminiClient` singleton from `src/lib/gemini.ts`.
 * Does NOT construct a new VertexAI instance. Adds the four
 * cross-cutting concerns that every Gemini-using service needs:
 *
 *   1. Per-call configuration (responseMimeType set HERE, not at
 *      client level, per the singleton's hard rule)
 *   2. One-shot retry on transient failure (5xx, timeout)
 *   3. Structured Pino logging with the brief's required fields
 *   4. AIUsage ledger write for cost reconciliation
 *
 * Higher-level orchestration services (AI tutor turn, placement
 * scorer, RARPA evidence synthesiser) call `generateTurn` and let
 * this layer handle the retry / logging / billing plumbing.
 */

// ─────────────────────────────────────────────────────────────────────
// Tunables
// ─────────────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 30_000; // 30 s per call
const RETRY_DELAY_MS = 1_000; // brief: 1 s after first failure
const DEFAULT_TEMPERATURE = 0.7;
// gemini-2.5-flash is a THINKING model: its internal reasoning tokens
// are billed and counted against maxOutputTokens alongside the visible
// answer. At 2048 the reasoning regularly consumed most of the budget
// and the JSON body was cut off mid-string ("...ne kadar para), failing
// JSON.parse and dropping the learner onto the ANCHOR fallback reply.
// This is a CAP, not a reservation — we still pay only for tokens
// actually generated, so the headroom costs nothing on normal turns.
const DEFAULT_MAX_OUTPUT_TOKENS = 8_192;

// ─────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────

export interface ConversationTurn {
  role: "user" | "model";
  content: string;
}

export interface GenerateTurnTracking {
  /** AISession._id when in a real tutor session; the placement attempt id
   *  when scoring placement; null/string for system calls. */
  sessionId: string | Types.ObjectId | null;
  orgId: string | Types.ObjectId | null;
  learnerId: string | Types.ObjectId | null;
}

export interface GenerateTurnArgs {
  systemPrompt: string;
  conversationHistory: ConversationTurn[];
  userMessage: string;
  /** Vertex cached_content resource name returned by
   *  `cachedContents.create`. When set, Vertex serves the static
   *  prefix from cache and bills cached tokens at the discount rate. */
  cachedContentId?: string;
  /** Optional Vertex response-schema for structured-JSON modes
   *  (placement scoring, AI tutor turn). When omitted, the call
   *  expects free-form JSON validated by the caller. */
  responseSchema?: Record<string, unknown>;
  temperature?: number;
  maxOutputTokens?: number;
  /** Override the default 30 s timeout. */
  timeoutMs?: number;
  /** Tracking + billing context. Always passed; the wrapper logs and
   *  writes AIUsage regardless of whether the call is a real session
   *  or a system probe (system probes pass nulls). */
  tracking: GenerateTurnTracking;
  /**
   * Optional structural validator for the parsed JSON. When provided:
   *   - runs AFTER JSON.parse
   *   - on success, returns the validated/typed object as `parsed`
   *   - on failure, throws GeminiSchemaError with the raw body
   *     attached and a truncated-500-char log line
   *
   * Brief Function 7 To-Do 4 wires `validateGeminiTurnOutput` here
   * for the AI tutor path; the placement scorer uses its own
   * `parseScoringResponse`; system probes pass undefined.
   *
   * Throwing semantics (rather than Result<T, E>) matches the existing
   * try/catch shape inside `generateTurn`.
   */
  validate?: (parsed: unknown) => unknown;
}

export interface GenerateTurnResult<T = unknown> {
  /** Parsed JSON body. The caller's responsibility to validate the
   *  shape — GeminiSchemaError covers the parse failure case, but a
   *  parse-succeeds-but-shape-is-wrong outcome is the caller's. */
  parsed: T;
  /** Raw text from Gemini (useful for the caller's audit row). */
  rawText: string;
  /** Token + latency diagnostics matching the AIUsage ledger row. */
  usage: {
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    cacheHitRatio: number;
    latencyMs: number;
    retried: boolean;
  };
}

// ─────────────────────────────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Wrap a promise in a timeout. Throws GeminiTimeoutError on expiry.
 * Note: the underlying SDK call keeps running — Node has no abort
 * primitive for it — but the caller stops waiting at the deadline.
 */
const withTimeout = async <T>(
  promise: Promise<T>,
  ms: number,
  startedAt: number,
): Promise<T> => {
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new GeminiTimeoutError(
            `Gemini call did not complete within ${ms} ms`,
            Date.now() - startedAt,
          ),
        ),
      ms,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

/**
 * Classify an SDK-thrown error.
 *   - Vertex SDK errors expose `.code` (string like "DEADLINE_EXCEEDED")
 *     or `.status` / `.statusCode` (numeric HTTP code) depending on
 *     surface. We accept both.
 *   - 5xx → retriable. Cast to GeminiApiError on the second failure.
 *   - 4xx → not retriable. Auth, quota, malformed request, etc.
 *   - Timeouts already arrive as GeminiTimeoutError from withTimeout.
 */
const isRetriableError = (err: unknown): boolean => {
  if (err instanceof GeminiTimeoutError) return true;
  if (!err || typeof err !== "object") return false;
  const e = err as {
    code?: unknown;
    status?: unknown;
    statusCode?: unknown;
    message?: unknown;
  };
  // Numeric HTTP status
  const status =
    typeof e.statusCode === "number"
      ? e.statusCode
      : typeof e.status === "number"
        ? e.status
        : NaN;
  if (Number.isFinite(status) && status >= 500 && status < 600) return true;
  // gRPC-style code names that Vertex surfaces
  if (typeof e.code === "string") {
    return [
      "DEADLINE_EXCEEDED",
      "UNAVAILABLE",
      "INTERNAL",
      "RESOURCE_EXHAUSTED",
    ].includes(e.code);
  }
  // Sometimes the SDK throws plain Error with a message we recognise.
  if (typeof e.message === "string") {
    return /\b(503|502|500|timeout|deadline)\b/i.test(e.message);
  }
  return false;
};

const extractStatusCode = (err: unknown): number | undefined => {
  if (!err || typeof err !== "object") return undefined;
  const e = err as { status?: unknown; statusCode?: unknown };
  if (typeof e.statusCode === "number") return e.statusCode;
  if (typeof e.status === "number") return e.status;
  return undefined;
};

/**
 * Run a single Vertex `generateContent` call with the configured
 * generation parameters. Pure of retry / logging concerns — those
 * live in the outer `generateTurn`.
 */
const callOnce = async (
  args: GenerateTurnArgs,
  startedAt: number,
): Promise<{
  rawText: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}> => {
  const model = geminiClient.preview.getGenerativeModel({
    model: MODEL_NAME,
    systemInstruction: {
      role: "system",
      parts: [{ text: args.systemPrompt }],
    },
    generationConfig: {
      // Per the singleton contract: responseMimeType is set HERE,
      // per-call, never at client level.
      responseMimeType: "application/json",
      ...(args.responseSchema && {
        responseSchema: args.responseSchema as any,
      }),
      temperature: args.temperature ?? DEFAULT_TEMPERATURE,
      maxOutputTokens: args.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    },
    // cachedContent ties the static prefix to a Vertex cache resource.
    // When undefined, the call proceeds without caching.
    ...(args.cachedContentId &&
      ({ cachedContent: args.cachedContentId } as any)),
  });

  const contents = [
    ...args.conversationHistory.map((h) => ({
      role: h.role,
      parts: [{ text: h.content }],
    })),
    { role: "user", parts: [{ text: args.userMessage }] },
  ];

  const result = await withTimeout(
    model.generateContent({ contents }),
    args.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    startedAt,
  );

  const candidate = result.response?.candidates?.[0];
  const rawText = candidate?.content?.parts?.[0]?.text ?? "";

  // Name the cause rather than letting it surface as an unexplained
  // "non-JSON body" downstream: on a thinking model the reasoning can
  // exhaust maxOutputTokens and cut the JSON off mid-string.
  if (candidate?.finishReason === "MAX_TOKENS") {
    logger.error(
      {
        session_id: args.tracking.sessionId,
        max_output_tokens: args.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
        raw_text_length: rawText.length,
      },
      "Gemini response TRUNCATED (MAX_TOKENS) — thinking budget exhausted maxOutputTokens; raise it",
    );
  }

  const usage = result.response?.usageMetadata;
  return {
    rawText,
    inputTokens: usage?.promptTokenCount ?? 0,
    outputTokens: usage?.candidatesTokenCount ?? 0,
    cachedTokens: usage?.cachedContentTokenCount ?? 0,
  };
};

const toObjectIdOrNull = (
  v: string | Types.ObjectId | null,
): Types.ObjectId | null => {
  if (!v) return null;
  if (v instanceof Types.ObjectId) return v;
  return Types.ObjectId.isValid(v) ? new Types.ObjectId(v) : null;
};

/**
 * Fire-and-forget AIUsage ledger write. Failures are logged but never
 * propagated — we don't want a billing-row glitch to fail the
 * learner's turn.
 */
const recordUsage = (
  args: GenerateTurnArgs,
  usage: {
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    latencyMs: number;
    retried: boolean;
  },
): void => {
  AIUsage.create({
    org_id: toObjectIdOrNull(args.tracking.orgId),
    learner_id: toObjectIdOrNull(args.tracking.learnerId),
    session_id:
      typeof args.tracking.sessionId === "string"
        ? args.tracking.sessionId
        : (args.tracking.sessionId ?? null),
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    cached_tokens: usage.cachedTokens,
    model_name: MODEL_NAME,
    latency_ms: usage.latencyMs,
    retried: usage.retried,
    timestamp: new Date(),
  }).catch((err) =>
    logger.error(
      {
        err,
        sessionId: args.tracking.sessionId,
        orgId: args.tracking.orgId,
        learnerId: args.tracking.learnerId,
      },
      "AIUsage ledger write failed — call succeeded, billing row missing",
    ),
  );
};

// ─────────────────────────────────────────────────────────────────────
// Public entry point
// ─────────────────────────────────────────────────────────────────────

/**
 * Call Gemini with retry, logging, and cost tracking.
 *
 * Retry policy:
 *   - On transient failure (timeout, 5xx, RESOURCE_EXHAUSTED), wait
 *     1 s and retry ONCE.
 *   - On second failure, throw GeminiApiError (or rethrow
 *     GeminiTimeoutError if both attempts timed out — the caller can
 *     still introspect `.retriable` if they want to retry at a higher
 *     level).
 *
 * Schema handling:
 *   - Empty response body → GeminiApiError.
 *   - Non-JSON body → GeminiSchemaError with the raw text attached.
 *   - The caller validates the parsed shape; this wrapper only
 *     guarantees "valid JSON".
 *
 * Logging:
 *   - Every completed call (success OR final failure) logs at INFO
 *     with the brief's fields: session_id, latency_ms,
 *     token_count_in, token_count_out, cache_hit_ratio.
 *
 * Billing:
 *   - Successful call → one AIUsage row, fire-and-forget.
 *   - Failed call → no row (we don't bill for failures).
 */
export const generateTurn = async <T = unknown>(
  args: GenerateTurnArgs,
): Promise<GenerateTurnResult<T>> => {
  const startedAt = Date.now();
  let attempt = 1;
  let lastError: unknown = null;
  let retried = false;

  // ── Try up to twice ─────────────────────────────────────────────
  while (attempt <= 2) {
    try {
      const out = await callOnce(args, startedAt);
      if (!out.rawText) {
        throw new GeminiApiError("Empty response from Gemini", {
          statusCode: 200,
        });
      }
      let parsed: T;
      try {
        parsed = JSON.parse(out.rawText) as T;
      } catch {
        throw new GeminiSchemaError(
          `Gemini returned non-JSON body (length ${out.rawText.length})`,
          out.rawText,
        );
      }

      // Schema validation — brief Function 7 To-Do 4. Optional per call;
      // when the caller provides a validator we run it and convert any
      // failure into a GeminiSchemaError with the raw body attached.
      if (args.validate) {
        try {
          parsed = args.validate(parsed) as T;
        } catch (validationErr) {
          const issueMessage =
            validationErr instanceof Error
              ? validationErr.message
              : String(validationErr);
          // Brief: log validation failures with raw output truncated
          // to 500 chars so ops can see what Gemini returned wrongly.
          logger.warn(
            {
              session_id: args.tracking.sessionId,
              org_id: args.tracking.orgId,
              learner_id: args.tracking.learnerId,
              validation_error: issueMessage,
              raw_output_preview: out.rawText.slice(0, 500),
              raw_output_length: out.rawText.length,
            },
            "gemini output failed schema validation",
          );
          throw new GeminiSchemaError(issueMessage, out.rawText);
        }
      }

      const latencyMs = Date.now() - startedAt;
      const cacheHitRatio =
        out.inputTokens > 0 ? out.cachedTokens / out.inputTokens : 0;

      logger.info(
        {
          session_id: args.tracking.sessionId,
          latency_ms: latencyMs,
          token_count_in: out.inputTokens,
          token_count_out: out.outputTokens,
          cache_hit_ratio: cacheHitRatio,
          retried,
        },
        "gemini call complete",
      );

      recordUsage(args, {
        inputTokens: out.inputTokens,
        outputTokens: out.outputTokens,
        cachedTokens: out.cachedTokens,
        latencyMs,
        retried,
      });

      return {
        parsed,
        rawText: out.rawText,
        usage: {
          inputTokens: out.inputTokens,
          outputTokens: out.outputTokens,
          cachedTokens: out.cachedTokens,
          cacheHitRatio,
          latencyMs,
          retried,
        },
      };
    } catch (err) {
      // GeminiSchemaError is NEVER retriable — the model returned text,
      // it just wasn't JSON. Same content on retry, same failure.
      if (err instanceof GeminiSchemaError) {
        logger.warn(
          {
            session_id: args.tracking.sessionId,
            latency_ms: Date.now() - startedAt,
            err,
            // The body itself is the only thing that explains WHY the
            // turn fell back (markdown fence, refusal text, truncation).
            // Without it every fallback looks identical in the logs.
            raw_body_snippet: (err.rawBody ?? "").slice(0, 500),
            raw_body_length: (err.rawBody ?? "").length,
          },
          "gemini call returned non-JSON body",
        );
        throw err;
      }

      lastError = err;
      const canRetry = attempt === 1 && isRetriableError(err);
      logger.warn(
        {
          session_id: args.tracking.sessionId,
          attempt,
          willRetry: canRetry,
          err:
            err instanceof Error
              ? { name: err.name, message: err.message }
              : err,
        },
        "gemini call failed",
      );

      if (!canRetry) break;
      retried = true;
      attempt += 1;
      await sleep(RETRY_DELAY_MS);
    }
  }

  // ── Both attempts exhausted ─────────────────────────────────────
  const latencyMs = Date.now() - startedAt;
  logger.error(
    {
      session_id: args.tracking.sessionId,
      latency_ms: latencyMs,
      retried,
      err:
        lastError instanceof Error
          ? { name: lastError.name, message: lastError.message }
          : lastError,
    },
    "gemini call failed after retries",
  );

  if (lastError instanceof GeminiTimeoutError) {
    // Surface as GeminiApiError so callers have a single "did the
    // upstream API give up" exception to catch. The original timeout
    // sits in `.cause` for diagnostics.
    throw new GeminiApiError("Gemini call timed out after retry", {
      cause: lastError,
    });
  }

  const statusCode = extractStatusCode(lastError);
  throw new GeminiApiError(
    lastError instanceof Error ? lastError.message : "Gemini call failed",
    { statusCode, cause: lastError },
  );
};

// Re-export the error classes so callers have one import path for the
// vendor-error surface.
export {
  GeminiApiError,
  GeminiSchemaError,
  GeminiTimeoutError,
} from "../errors/geminiErrors";
