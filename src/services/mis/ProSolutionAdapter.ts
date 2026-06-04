/**
 * ProSolution MIS adapter — Final Addendum §7, Phase 21.
 *
 * Implements `IMISAdapter` against Advanced Learner Management
 * Solutions' ProSolution REST API.
 *
 * Status
 * ======
 *
 * **MVP scaffold.** The transport, error handling, retry policy,
 * logging, and chunking logic are production-shaped. The PROSOLUTION
 * field-name mappings and exact endpoint paths are documented as
 * **TODOs to be confirmed with ALS when the first ProSolution
 * customer signs**. Today, the adapter assumes:
 *
 *   - REST + API key in `Authorization: Bearer <credentials>` header.
 *   - JSON request + response bodies.
 *   - `POST /api/learners`            single push
 *   - `POST /api/learners/batch`      batch push (≤ 100 per call)
 *   - `GET  /api/learners/:uln`       status pull
 *
 * Joey confirms the actual API contract during onboarding of the
 * first ProSolution customer. When confirmed, the TODOs near the
 * top of this file flip from placeholders to the real wire names;
 * the rest of the file stays put.
 *
 * Transport choice
 * ================
 *
 * The codebase does not depend on `axios` (backend uses Node 22's
 * built-in `fetch`). Rather than add a dependency for this stub,
 * the adapter wraps `fetch` in a tiny internal `httpRequest`
 * helper that mirrors axios's ergonomic surface (timeout, retry,
 * `.data`). Phase 21 can swap to `axios` in a one-line edit if a
 * future preference emerges — every call site here is contained.
 *
 * Error handling
 * ==============
 *
 *   - **401**  → throw `MISAuthError`. Credentials are bad; the
 *                caller's pipeline must stop and re-prompt the org
 *                admin via the Function 15 §7 settings panel.
 *   - **4xx**  → return `{ success: false, error: <message> }`.
 *                The MIS rejected this specific record (validation,
 *                duplicate, conflict). The push as a whole continues.
 *   - **5xx**  → retry ONCE after 5 s. If the second attempt also
 *                5xxs, throw `MISServerError`. The caller (typically
 *                the mis-push BullMQ worker) treats the throw as
 *                retryable — BullMQ schedules the next attempt; the
 *                failed-jobs collection captures it after retries
 *                are exhausted.
 *   - **network** (no response at all): treated as 5xx for retry
 *                purposes.
 *
 * Logging
 * =======
 *
 * Every push (single and per-record in a batch) emits one Pino log
 * line at info level with these fields (per brief Function 15 §7):
 *
 *   org_id, provider: "ProSolution", uln, success, latency_ms
 *
 * Plus on failure: error_kind ("auth" / "client" / "server"),
 * http_status when available.
 *
 * Privacy
 * =======
 *
 * The adapter NEVER logs `record.firstname`, `record.lastname`,
 * `record.date_of_birth`, `record.raw_payload`, or the response
 * body content. Only ULN + outcome metadata.
 */

import logger from "../../config/logger";
import {
  IMISAdapter,
  MISAdapterConfig,
  MISAuthError,
  MISPushResult,
  MISRecord,
  MISServerError,
} from "./types";

// ─────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────

const PROVIDER = "ProSolution" as const;

/** ProSolution caps its batch endpoint at 100 records per call. */
const BATCH_LIMIT = 100;

/** Per-request HTTP timeout. ProSolution's batch endpoint is the slow path. */
const REQUEST_TIMEOUT_MS = 30_000;
const BATCH_REQUEST_TIMEOUT_MS = 90_000;

/** 5xx retry: ONE retry after 5 s, per the brief's spec. */
const RETRY_DELAY_MS = 5_000;

// ─────────────────────────────────────────────────────────────────────
// Field-name transform map — MISRecord → ProSolution wire names
// ─────────────────────────────────────────────────────────────────────

/**
 * TODO(Phase 21 first ProSolution customer): confirm the actual
 * ProSolution wire field names with ALS. The keys below are the
 * platform-side `MISRecord` field names; the values are the
 * placeholder ProSolution names. Update the values verbatim from
 * the ProSolution API spec when obtained.
 *
 * The mapping is centralised here so a future schema change is a
 * one-file edit. Build and ship a smoke test against ProSolution's
 * sandbox before flipping any placeholder to a real name.
 */
const FIELD_MAP: Record<keyof Omit<MISRecord, "raw_payload">, string> = {
  uln: "ULN", // TODO confirm — ProSolution may use camelCase or "learnerULN"
  firstname: "FirstName", // TODO confirm
  lastname: "LastName", // TODO confirm
  date_of_birth: "DateOfBirth", // TODO confirm — ISO 8601 or DD/MM/YYYY?
  esol_level: "ESOLLevel", // TODO confirm
  learn_start_date: "LearnStartDate", // TODO confirm
  learn_plan_end_date: "LearnPlanEndDate", // TODO confirm
  learn_act_end_date: "LearnActEndDate", // TODO confirm
  outcome: "Outcome", // TODO confirm
  comp_status: "CompStatus", // TODO confirm
  sof: "SOF", // TODO confirm
  add_hours: "AdditionalHours", // TODO confirm
  english_prog_type: "EnglishProgType", // TODO confirm
  total_glh: "TotalGLH", // TODO confirm
  skill_codes_covered: "SkillCodes", // TODO confirm — array or comma-separated string?
};

/**
 * Build the wire payload from a `MISRecord`. Pure function — no
 * side effects, no logging — so tests can exercise the mapping
 * directly. `raw_payload` is merged LAST so adapter-specific
 * extras can override the typed fields (escape hatch for the rare
 * case the typed shape can't express what ProSolution needs).
 */
const toProSolutionPayload = (
  record: MISRecord,
): Record<string, unknown> => {
  const payload: Record<string, unknown> = {};
  for (const [platformField, wireField] of Object.entries(FIELD_MAP)) {
    const value = (record as unknown as Record<string, unknown>)[platformField];
    if (value !== undefined) payload[wireField] = value;
  }
  // Adapter-specific overrides last — see field-map header comment.
  if (record.raw_payload && typeof record.raw_payload === "object") {
    Object.assign(payload, record.raw_payload);
  }
  return payload;
};

// ─────────────────────────────────────────────────────────────────────
// HTTP transport — fetch-based, axios-like ergonomics
// ─────────────────────────────────────────────────────────────────────

interface HttpResponse<T = unknown> {
  status: number;
  data: T;
}

/**
 * Internal fetch wrapper. Centralises timeout + JSON
 * (de)serialisation + the 5xx-retry-once policy. NOT exported —
 * every external caller goes through `pushLearner` /
 * `pushBatch` / `pullLearnerStatus`.
 *
 * Throws on transport failure (network down, timeout). Returns
 * the raw response for 2xx / 4xx — the caller branches on
 * `.status`.
 */
const httpRequest = async <T = unknown>(input: {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: unknown;
  timeoutMs: number;
  attempt?: number;
}): Promise<HttpResponse<T>> => {
  const attempt = input.attempt ?? 1;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);

  try {
    const res = await fetch(input.url, {
      method: input.method,
      headers: input.headers,
      body: input.body !== undefined ? JSON.stringify(input.body) : undefined,
      signal: controller.signal,
    });

    // Try to JSON-parse the body; tolerate empty bodies.
    let data: unknown = null;
    const text = await res.text();
    if (text.length > 0) {
      try {
        data = JSON.parse(text);
      } catch {
        // Non-JSON body — surface the raw text under a wrapper so
        // the error message in the result envelope is still useful.
        data = { message: text };
      }
    }

    // 5xx retry policy: one retry, 5s later, then surface.
    if (res.status >= 500 && attempt === 1) {
      clearTimeout(timer);
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      return httpRequest<T>({ ...input, attempt: 2 });
    }

    return { status: res.status, data: data as T };
  } catch (err) {
    // AbortError (timeout) or DNS / network failure: treat as 5xx
    // for retry purposes — same logic.
    if (attempt === 1) {
      clearTimeout(timer);
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      return httpRequest<T>({ ...input, attempt: 2 });
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
};

// ─────────────────────────────────────────────────────────────────────
// Adapter class
// ─────────────────────────────────────────────────────────────────────

export class ProSolutionAdapter implements IMISAdapter {
  private readonly endpoint: string;
  private readonly credentials: string;
  private readonly org_id: string;

  constructor(config: MISAdapterConfig) {
    if (!config.endpoint) {
      throw new Error("ProSolutionAdapter: endpoint is required");
    }
    if (!config.credentials) {
      throw new Error("ProSolutionAdapter: credentials are required");
    }
    if (!config.org_id) {
      throw new Error("ProSolutionAdapter: org_id is required");
    }
    // Trim a trailing slash so URL-join is consistent across callers.
    this.endpoint = config.endpoint.replace(/\/+$/, "");
    this.credentials = config.credentials;
    this.org_id = config.org_id;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.credentials}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    };
  }

  // ── testConnection ─────────────────────────────────────────────
  // ProSolution doesn't (yet?) publish a dedicated health endpoint.
  // We probe by issuing a GET against a known-cheap path — TODO
  // confirm during onboarding which path is the right one.
  // `/api/learners?limit=1` is the conservative default: returns 401
  // for bad creds, 200 for good, doesn't write anything.
  async testConnection(): Promise<boolean> {
    try {
      const res = await httpRequest({
        url: `${this.endpoint}/api/learners?limit=1`,
        method: "GET",
        headers: this.headers(),
        timeoutMs: REQUEST_TIMEOUT_MS,
      });
      if (res.status === 401) return false;
      // 2xx or 4xx (other than 401): the MIS is reachable + our
      // creds parse. 4xx-other typically means "your account has
      // no read scope" — credentials are valid, just under-scoped.
      // Returning true here is the right answer for "is this
      // adapter usable?" — false means "rotate the credentials".
      return res.status < 500;
    } catch (err) {
      // Transport failure / timeout: throw rather than report false.
      // The caller distinguishes "MIS down" from "creds bad".
      throw new MISServerError(
        PROVIDER,
        this.org_id,
        `ProSolution testConnection transport failure: ${(err as Error).message}`,
      );
    }
  }

  // ── pushLearner ────────────────────────────────────────────────
  async pushLearner(record: MISRecord): Promise<MISPushResult> {
    const startedAt = Date.now();
    const payload = toProSolutionPayload(record);

    let res: HttpResponse<{
      id?: string;
      message?: string;
      warnings?: string[];
    }>;
    try {
      res = await httpRequest({
        url: `${this.endpoint}/api/learners`,
        method: "POST",
        headers: this.headers(),
        body: payload,
        timeoutMs: REQUEST_TIMEOUT_MS,
      });
    } catch (err) {
      const latency_ms = Date.now() - startedAt;
      logger.error(
        {
          org_id: this.org_id,
          provider: PROVIDER,
          uln: record.uln,
          success: false,
          latency_ms,
          error_kind: "server",
          message: (err as Error).message,
        },
        "ProSolution push: transport failure",
      );
      throw new MISServerError(
        PROVIDER,
        this.org_id,
        `ProSolution push transport failure: ${(err as Error).message}`,
      );
    }

    return this.interpretPushResponse({
      record_uln: record.uln,
      status: res.status,
      data: res.data,
      latency_ms: Date.now() - startedAt,
    });
  }

  // ── pushBatch ──────────────────────────────────────────────────
  // ProSolution caps the batch endpoint at 100 records. If the
  // caller hands us more, we chunk into 100-record requests and
  // concatenate the per-record results in input order so the caller
  // can correlate failures back to the source row.
  async pushBatch(records: MISRecord[]): Promise<MISPushResult[]> {
    if (records.length === 0) return [];

    const results: MISPushResult[] = [];
    for (let offset = 0; offset < records.length; offset += BATCH_LIMIT) {
      const chunk = records.slice(offset, offset + BATCH_LIMIT);
      const chunkResults = await this.pushOneChunk(chunk);
      results.push(...chunkResults);
    }
    return results;
  }

  private async pushOneChunk(
    chunk: MISRecord[],
  ): Promise<MISPushResult[]> {
    const startedAt = Date.now();
    const payload = {
      learners: chunk.map(toProSolutionPayload),
    };

    let res: HttpResponse<{
      results?: Array<{
        uln?: string;
        id?: string;
        success?: boolean;
        message?: string;
        warnings?: string[];
      }>;
      message?: string;
    }>;
    try {
      res = await httpRequest({
        url: `${this.endpoint}/api/learners/batch`,
        method: "POST",
        headers: this.headers(),
        body: payload,
        timeoutMs: BATCH_REQUEST_TIMEOUT_MS,
      });
    } catch (err) {
      logger.error(
        {
          org_id: this.org_id,
          provider: PROVIDER,
          batch_size: chunk.length,
          success: false,
          latency_ms: Date.now() - startedAt,
          error_kind: "server",
          message: (err as Error).message,
        },
        "ProSolution batch: transport failure",
      );
      throw new MISServerError(
        PROVIDER,
        this.org_id,
        `ProSolution batch transport failure: ${(err as Error).message}`,
      );
    }

    // 401 on a batch — credentials are bad. None of the records made
    // it through; the caller's pipeline must stop.
    if (res.status === 401) {
      logger.error(
        {
          org_id: this.org_id,
          provider: PROVIDER,
          batch_size: chunk.length,
          success: false,
          latency_ms: Date.now() - startedAt,
          error_kind: "auth",
          http_status: 401,
        },
        "ProSolution batch: credentials rejected",
      );
      throw new MISAuthError(
        PROVIDER,
        this.org_id,
        "ProSolution rejected the supplied credentials on a batch push.",
      );
    }

    // 5xx after retry — server hard failure. None of the records
    // made it; the caller schedules retry.
    if (res.status >= 500) {
      logger.error(
        {
          org_id: this.org_id,
          provider: PROVIDER,
          batch_size: chunk.length,
          success: false,
          latency_ms: Date.now() - startedAt,
          error_kind: "server",
          http_status: res.status,
        },
        "ProSolution batch: server error after retry",
      );
      throw new MISServerError(
        PROVIDER,
        this.org_id,
        `ProSolution batch returned ${res.status} after retry.`,
        res.status,
      );
    }

    // 2xx — ProSolution returns a per-record results array. Map
    // it back to MISPushResult, preserving INPUT order. If the
    // response is missing or under-sized, the missing slots are
    // marked as `success: false, error: "no response from MIS"`
    // so the caller doesn't silently lose records.
    const wireResults = Array.isArray(res.data?.results)
      ? res.data!.results!
      : [];
    const wireByUln = new Map<string, (typeof wireResults)[number]>();
    for (const wr of wireResults) {
      if (wr.uln) wireByUln.set(wr.uln, wr);
    }

    const latency_ms = Date.now() - startedAt;
    const out: MISPushResult[] = chunk.map((record) => {
      const wr = wireByUln.get(record.uln);
      if (!wr) {
        logger.warn(
          {
            org_id: this.org_id,
            provider: PROVIDER,
            uln: record.uln,
            success: false,
            latency_ms,
            error_kind: "client",
            message: "no per-record entry in batch response",
          },
          "ProSolution batch: record missing from response",
        );
        return {
          success: false,
          error: "ProSolution batch response omitted this record",
        };
      }
      // 4xx-style per-record failures land here as `success: false`.
      const ok = wr.success === true && typeof wr.id === "string";
      logger.info(
        {
          org_id: this.org_id,
          provider: PROVIDER,
          uln: record.uln,
          success: ok,
          latency_ms,
          ...(ok ? {} : { error_kind: "client", message: wr.message }),
        },
        ok
          ? "ProSolution batch push: record succeeded"
          : "ProSolution batch push: record failed",
      );
      return ok
        ? {
            success: true,
            provider_record_id: wr.id,
            ...(wr.warnings && wr.warnings.length > 0
              ? { warnings: wr.warnings }
              : {}),
          }
        : {
            success: false,
            error: wr.message ?? "ProSolution rejected this record",
            ...(wr.warnings && wr.warnings.length > 0
              ? { warnings: wr.warnings }
              : {}),
          };
    });
    return out;
  }

  // ── pullLearnerStatus ──────────────────────────────────────────
  async pullLearnerStatus(
    uln: string,
  ): Promise<{ status: string; last_updated: string } | null> {
    const startedAt = Date.now();

    let res: HttpResponse<{
      status?: string;
      last_updated?: string;
      message?: string;
    }>;
    try {
      res = await httpRequest({
        url: `${this.endpoint}/api/learners/${encodeURIComponent(uln)}`,
        method: "GET",
        headers: this.headers(),
        timeoutMs: REQUEST_TIMEOUT_MS,
      });
    } catch (err) {
      throw new MISServerError(
        PROVIDER,
        this.org_id,
        `ProSolution pull transport failure: ${(err as Error).message}`,
      );
    }

    const latency_ms = Date.now() - startedAt;

    if (res.status === 401) {
      throw new MISAuthError(
        PROVIDER,
        this.org_id,
        "ProSolution rejected the supplied credentials on a status pull.",
      );
    }
    if (res.status === 404) {
      // Normal case — the MIS doesn't know this ULN yet. Caller
      // (delta-sync cron) treats null as "skip this learner".
      logger.info(
        { org_id: this.org_id, provider: PROVIDER, uln, http_status: 404, latency_ms },
        "ProSolution pull: learner not found",
      );
      return null;
    }
    if (res.status >= 500) {
      throw new MISServerError(
        PROVIDER,
        this.org_id,
        `ProSolution pull returned ${res.status} after retry.`,
        res.status,
      );
    }
    if (res.status >= 400) {
      // Other 4xx — log and return null so the cron continues with
      // other learners. The 4xx is recorded in the failed-jobs
      // dashboard via the worker layer.
      logger.warn(
        {
          org_id: this.org_id,
          provider: PROVIDER,
          uln,
          http_status: res.status,
          latency_ms,
          message: res.data?.message,
        },
        "ProSolution pull: client error",
      );
      return null;
    }

    if (typeof res.data?.status !== "string") {
      logger.warn(
        { org_id: this.org_id, provider: PROVIDER, uln, latency_ms },
        "ProSolution pull: response missing status field",
      );
      return null;
    }

    return {
      status: res.data.status,
      last_updated: res.data.last_updated ?? new Date().toISOString(),
    };
  }

  // ── interpretPushResponse — shared by pushLearner ──────────────
  private interpretPushResponse(input: {
    record_uln: string;
    status: number;
    data: { id?: string; message?: string; warnings?: string[] };
    latency_ms: number;
  }): MISPushResult {
    const { status, data, latency_ms, record_uln } = input;

    // 401 — credentials bad; bubble up. The pipeline stops.
    if (status === 401) {
      logger.error(
        {
          org_id: this.org_id,
          provider: PROVIDER,
          uln: record_uln,
          success: false,
          latency_ms,
          error_kind: "auth",
          http_status: 401,
        },
        "ProSolution push: credentials rejected",
      );
      throw new MISAuthError(
        PROVIDER,
        this.org_id,
        "ProSolution rejected the supplied credentials on a push.",
      );
    }

    // 5xx after retry — server hard failure; bubble up. BullMQ
    // schedules the next attempt.
    if (status >= 500) {
      logger.error(
        {
          org_id: this.org_id,
          provider: PROVIDER,
          uln: record_uln,
          success: false,
          latency_ms,
          error_kind: "server",
          http_status: status,
        },
        "ProSolution push: server error after retry",
      );
      throw new MISServerError(
        PROVIDER,
        this.org_id,
        `ProSolution push returned ${status} after retry.`,
        status,
      );
    }

    // 4xx — graded MIS rejection for this record. Surface as a
    // result envelope; the caller decides whether the row is
    // re-driveable.
    if (status >= 400) {
      logger.info(
        {
          org_id: this.org_id,
          provider: PROVIDER,
          uln: record_uln,
          success: false,
          latency_ms,
          error_kind: "client",
          http_status: status,
          message: data?.message,
        },
        "ProSolution push: record rejected",
      );
      return {
        success: false,
        error: data?.message ?? `ProSolution rejected the record (HTTP ${status})`,
        ...(data?.warnings && data.warnings.length > 0
          ? { warnings: data.warnings }
          : {}),
      };
    }

    // 2xx — success. ProSolution should return the persisted id.
    if (typeof data?.id !== "string") {
      logger.warn(
        {
          org_id: this.org_id,
          provider: PROVIDER,
          uln: record_uln,
          latency_ms,
          http_status: status,
        },
        "ProSolution push: 2xx response missing id field",
      );
      return {
        success: false,
        error: "ProSolution responded 2xx but omitted the record id",
      };
    }

    logger.info(
      {
        org_id: this.org_id,
        provider: PROVIDER,
        uln: record_uln,
        success: true,
        latency_ms,
        provider_record_id: data.id,
      },
      "ProSolution push: success",
    );
    return {
      success: true,
      provider_record_id: data.id,
      ...(data.warnings && data.warnings.length > 0
        ? { warnings: data.warnings }
        : {}),
    };
  }
}

// ─────────────────────────────────────────────────────────────────────
// Factory — what the Phase 21 service layer calls to instantiate
// ─────────────────────────────────────────────────────────────────────

/**
 * Factory matching `IMISAdapterFactory`. The Phase 21 service layer
 * reads `Organisation.misType === "ProSolution"`, decrypts
 * `Organisation.misApiCredentials` via
 * `lib/misCredentials.decryptMisCredentials()`, then calls this
 * factory to get a usable adapter for the current request.
 */
export const createProSolutionAdapter = (
  config: MISAdapterConfig,
): IMISAdapter => new ProSolutionAdapter(config);

// Re-export internals for tests
export const __internals__ = {
  toProSolutionPayload,
  FIELD_MAP,
};
