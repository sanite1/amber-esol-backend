/**
 * Gemini-specific error classes — brief Function 9.
 *
 * Three error types with different recovery semantics:
 *
 *   GeminiTimeoutError  — the call exceeded the per-request timeout.
 *                         Retriable. The wrapper handles one auto-retry;
 *                         a second timeout escalates to GeminiApiError.
 *
 *   GeminiApiError      — non-recoverable API failure. The wrapper has
 *                         already exhausted its retry budget OR the
 *                         error is non-retriable (4xx, malformed request,
 *                         auth failure, quota exhausted).
 *
 *   GeminiSchemaError   — Gemini responded successfully but the body
 *                         doesn't parse as the expected JSON schema.
 *                         Handled by the caller (Function 9 To-Do 4);
 *                         the placement scorer's retry-then-fallback
 *                         pattern is the canonical recovery.
 *
 * All three extend `Error` rather than `ApiError` because they describe
 * upstream-vendor failures, not HTTP-shaped errors to surface to the
 * client directly. The caller decides how to translate them — a tutor
 * turn might serve a "try again" panel, a scorer might fall back to e1.
 */

export class GeminiTimeoutError extends Error {
  public readonly retriable = true;
  public readonly latencyMs: number;
  constructor(message: string, latencyMs: number) {
    super(message);
    this.name = "GeminiTimeoutError";
    this.latencyMs = latencyMs;
  }
}

export class GeminiApiError extends Error {
  public readonly retriable = false;
  public readonly statusCode?: number;
  public readonly cause?: unknown;
  constructor(message: string, opts: { statusCode?: number; cause?: unknown } = {}) {
    super(message);
    this.name = "GeminiApiError";
    this.statusCode = opts.statusCode;
    this.cause = opts.cause;
  }
}

export class GeminiSchemaError extends Error {
  public readonly retriable = false;
  /** Raw text Gemini returned — useful for the caller's fallback logging. */
  public readonly rawBody: string;
  constructor(message: string, rawBody: string) {
    super(message);
    this.name = "GeminiSchemaError";
    this.rawBody = rawBody;
  }
}
