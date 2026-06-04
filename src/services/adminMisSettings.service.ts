/**
 * Admin MIS settings service — Final Addendum §7.
 *
 * Two flows:
 *
 *   PATCH /api/admin/orgs/:id/mis-settings    updateMisSettingsService
 *     Validates inputs, encrypts credentials via cryptr, persists the
 *     updated org doc, writes an AuditLog row with credentials
 *     redacted on BOTH before_state and after_state.
 *
 *   POST  /api/admin/orgs/:id/mis-test-connection
 *                                             testMisConnectionService
 *     Decrypts credentials, dispatches to the matching MIS adapter's
 *     testConnection(). Returns the adapter's MisTestResult verbatim
 *     — never the credentials.
 *
 * Privacy invariants enforced here, not at the controller
 * =======================================================
 *
 *   1. Plaintext credentials never appear in the response body,
 *      the AuditLog `after_state`, or any log line. The service
 *      receives plaintext from the route once, encrypts immediately,
 *      and forgets the original string.
 *   2. `before_state` redacts whatever ciphertext was previously
 *      stored to "***". An auditor doesn't need to see the *old*
 *      encrypted string either — knowing the credentials changed is
 *      enough.
 *   3. The decrypt path is wrapped so a decrypt failure (eg.
 *      MIS_CREDENTIALS_KEY rotated without re-encrypting) surfaces as
 *      a structured 500 the UI can render, not a stack trace.
 */

import { Types } from "mongoose";
import { Request } from "express";
import ApiError from "../errors/apiError";
import ApiResponse from "../errors/apiResponse";
import Organisation from "../models/Organisation";
import {
  encryptMisCredentials,
  decryptMisCredentials,
} from "../lib/misCredentials";
import {
  getMisAdapter,
  ALL_MIS_TYPES,
  MisType,
  MisTestResult,
} from "../lib/misAdapters";
import { writeAuditLog } from "./auditLog.service";
import logger from "../config/logger";

// ─────────────────────────────────────────────────────────────────────
// Common helpers
// ─────────────────────────────────────────────────────────────────────

/** Redaction sentinel for AuditLog before/after states. */
const REDACTED = "***";

const isValidMisType = (v: unknown): v is MisType =>
  typeof v === "string" && (ALL_MIS_TYPES as readonly string[]).includes(v);

// ─────────────────────────────────────────────────────────────────────
// GET /api/admin/orgs/:id/mis-settings — populate the editor form
// ─────────────────────────────────────────────────────────────────────

export interface GetMisSettingsResult {
  org_id: string;
  misType: MisType;
  misApiEndpoint: string | null;
  /**
   * Whether credentials are stored. NEVER the ciphertext or any
   * derivative of it — booleans only.
   */
  has_credentials: boolean;
}

/**
 * Read-only accessor for the MIS settings form. Returns the
 * connection type and endpoint plus a "credentials present" boolean
 * so the UI can render "•••• (stored)" placeholder text without
 * exposing any byte of the stored value.
 */
export const getMisSettingsService = async (
  orgId: string,
): Promise<ApiResponse> => {
  if (!orgId || !Types.ObjectId.isValid(orgId)) {
    throw new ApiError(400, "org_id must be a valid ObjectId");
  }
  const org = await Organisation.findById(orgId)
    .select("misType misApiEndpoint misApiCredentials")
    .lean();
  if (!org) throw new ApiError(404, "Organisation not found");

  const result: GetMisSettingsResult = {
    org_id: orgId,
    misType: (org.misType ?? "none") as MisType,
    misApiEndpoint: org.misApiEndpoint ?? null,
    has_credentials: Boolean(org.misApiCredentials),
  };
  return new ApiResponse(200, "MIS settings", result);
};

// ─────────────────────────────────────────────────────────────────────
// PATCH /api/admin/orgs/:id/mis-settings
// ─────────────────────────────────────────────────────────────────────

export interface UpdateMisSettingsInput {
  org_id: string;
  caller_id: string;
  misType?: string;
  misApiEndpoint?: string | null;
  /**
   * Plaintext credentials, or omit to leave unchanged. Set to empty
   * string to clear (when misType moves to "none").
   */
  misApiCredentials?: string | null;
  req?: Request;
}

export interface UpdateMisSettingsResult {
  org_id: string;
  misType: MisType;
  misApiEndpoint: string | null;
  /** Always either null (no credentials stored) or "***" (stored & redacted). */
  misApiCredentials: null | "***";
  updated_at: string;
}

export const updateMisSettingsService = async (
  input: UpdateMisSettingsInput,
): Promise<ApiResponse> => {
  // ── 1. Validate ────────────────────────────────────────────────
  if (!input.org_id || !Types.ObjectId.isValid(input.org_id)) {
    throw new ApiError(400, "org_id must be a valid ObjectId");
  }
  if (!input.caller_id || !Types.ObjectId.isValid(input.caller_id)) {
    throw new ApiError(400, "Authenticated caller id required");
  }
  if (input.misType !== undefined && !isValidMisType(input.misType)) {
    throw new ApiError(
      400,
      `misType must be one of ${ALL_MIS_TYPES.join(", ")}`,
    );
  }
  if (
    input.misApiEndpoint !== undefined &&
    input.misApiEndpoint !== null &&
    typeof input.misApiEndpoint === "string" &&
    input.misApiEndpoint.length > 0
  ) {
    try {
      new URL(input.misApiEndpoint);
    } catch {
      throw new ApiError(400, "misApiEndpoint must be a valid URL");
    }
  }

  // ── 2. Load the existing org for the before-state snapshot ────
  // .select(+misApiCredentials) is unnecessary — the schema includes
  // it by default; the toJSON transform strips it on serialisation.
  // We pull the whole doc so we can mutate and save (mongoose's
  // change-tracking handles the partial update cleanly).
  const org = await Organisation.findById(input.org_id);
  if (!org) throw new ApiError(404, "Organisation not found");

  // Snapshot the current values BEFORE we mutate. We redact the
  // credentials value (it's already encrypted, but principle of
  // least disclosure applies — the audit trail should not echo any
  // form of credential, plaintext or ciphertext).
  const before_state = {
    misType: org.misType ?? "none",
    misApiEndpoint: org.misApiEndpoint ?? null,
    misApiCredentials: org.misApiCredentials ? REDACTED : null,
  };

  // ── 3. Apply updates ──────────────────────────────────────────
  if (input.misType !== undefined) {
    org.misType = input.misType as MisType;
    // If the admin moved to "none", clear any stored credentials so
    // they don't sit decryptable for an MIS we're no longer using.
    if (input.misType === "none") {
      org.misApiCredentials = null;
      org.misApiEndpoint = null;
    }
  }
  if (input.misApiEndpoint !== undefined) {
    org.misApiEndpoint = input.misApiEndpoint || null;
  }
  // Credentials are only TOUCHED when the request explicitly carries
  // a value. An empty string means "clear"; a non-empty string is
  // encrypted and stored. Omitting the field leaves the prior
  // ciphertext intact — important because the UI never echoes the
  // existing value, so re-saving the form mustn't wipe it.
  if (input.misApiCredentials !== undefined) {
    if (input.misApiCredentials === null || input.misApiCredentials === "") {
      org.misApiCredentials = null;
    } else {
      org.misApiCredentials = encryptMisCredentials(input.misApiCredentials);
    }
  }

  await org.save();

  // ── 4. After-state snapshot (also redacted) ───────────────────
  const after_state = {
    misType: org.misType ?? "none",
    misApiEndpoint: org.misApiEndpoint ?? null,
    misApiCredentials: org.misApiCredentials ? REDACTED : null,
  };

  // ── 5. AuditLog ───────────────────────────────────────────────
  await writeAuditLog(
    {
      actor_type: "amber_admin",
      actor_id: input.caller_id,
      org_id: input.org_id,
      learner_id: null,
      action: "mis_settings_updated",
      before_state,
      after_state,
      reason: `Amber admin updated MIS settings — type: ${after_state.misType}, endpoint: ${after_state.misApiEndpoint ?? "(none)"}, credentials: ${after_state.misApiCredentials === REDACTED ? "stored (encrypted)" : "cleared"}.`,
    },
    { req: input.req },
  );

  logger.info(
    {
      orgId: input.org_id,
      callerId: input.caller_id,
      misType: after_state.misType,
      credentials_present: after_state.misApiCredentials === REDACTED,
    },
    "updateMisSettings: persisted",
  );

  const result: UpdateMisSettingsResult = {
    org_id: input.org_id,
    misType: (org.misType ?? "none") as MisType,
    misApiEndpoint: org.misApiEndpoint ?? null,
    misApiCredentials: org.misApiCredentials ? REDACTED : null,
    updated_at: new Date().toISOString(),
  };

  return new ApiResponse(200, "MIS settings updated", result);
};

// ─────────────────────────────────────────────────────────────────────
// POST /api/admin/orgs/:id/mis-test-connection
// ─────────────────────────────────────────────────────────────────────

export interface TestMisConnectionResult extends MisTestResult {
  misType: MisType;
  endpoint: string | null;
  tested_at: string;
}

export const testMisConnectionService = async (
  orgId: string,
  callerId: string,
  req?: Request,
): Promise<ApiResponse> => {
  if (!orgId || !Types.ObjectId.isValid(orgId)) {
    throw new ApiError(400, "org_id must be a valid ObjectId");
  }

  const org = await Organisation.findById(orgId);
  if (!org) throw new ApiError(404, "Organisation not found");

  const misType = (org.misType ?? "none") as MisType;
  const endpoint = org.misApiEndpoint ?? null;

  // ── No MIS configured → structured "nothing to test" response ──
  // Returning 200 with `ok: false` and a clear message lets the UI
  // render the same banner regardless of which "test failed" path
  // we're on. The brief allows it.
  if (misType === "none") {
    return new ApiResponse(200, "MIS test connection", {
      ok: false,
      misType,
      endpoint,
      message: "No MIS is configured for this organisation.",
      tested_at: new Date().toISOString(),
    });
  }

  if (!endpoint) {
    return new ApiResponse(200, "MIS test connection", {
      ok: false,
      misType,
      endpoint,
      message: "MIS endpoint URL is not set. Save the URL before testing.",
      tested_at: new Date().toISOString(),
    });
  }

  // ── Decrypt credentials. Fail-closed if missing or corrupt. ────
  let credentials: string | null;
  try {
    credentials = decryptMisCredentials({
      misApiCredentials: org.misApiCredentials,
    });
  } catch (err) {
    logger.error(
      { err: (err as Error).message, orgId },
      "testMisConnection: decrypt failed",
    );
    return new ApiResponse(200, "MIS test connection", {
      ok: false,
      misType,
      endpoint,
      message:
        "Failed to decrypt stored MIS credentials. They may need to be re-entered (e.g. after a key rotation).",
      tested_at: new Date().toISOString(),
    });
  }
  if (!credentials) {
    return new ApiResponse(200, "MIS test connection", {
      ok: false,
      misType,
      endpoint,
      message: "No credentials stored. Save credentials before testing.",
      tested_at: new Date().toISOString(),
    });
  }

  // ── Dispatch to the adapter. The adapter NEVER throws on a
  // "wrong credentials" response — it returns ok:false. A throw
  // here is a true bug (Phase 21's HTTP client crashed, etc) and
  // gets reported as such. ───────────────────────────────────────
  const adapter = getMisAdapter(misType);
  if (!adapter) {
    return new ApiResponse(200, "MIS test connection", {
      ok: false,
      misType,
      endpoint,
      message: `No adapter registered for ${misType}.`,
      tested_at: new Date().toISOString(),
    });
  }

  let testResult: MisTestResult;
  try {
    testResult = await adapter.testConnection({ endpoint, credentials });
  } catch (err) {
    logger.error(
      { err: (err as Error).message, orgId, misType },
      "testMisConnection: adapter threw unexpectedly",
    );
    testResult = {
      ok: false,
      message: `Adapter error: ${(err as Error).message}`,
    };
  }

  // ── AuditLog the test attempt ─────────────────────────────────
  // Recorded so an org can later prove "we tested this connection
  // on date X". `after_state` includes only the outcome and the
  // adapter type — never the credentials.
  await writeAuditLog(
    {
      actor_type: "amber_admin",
      actor_id: callerId,
      org_id: orgId,
      learner_id: null,
      action: "mis_test_connection_attempted",
      before_state: null,
      after_state: {
        misType,
        endpoint,
        ok: testResult.ok,
        message: testResult.message,
      },
      reason: `MIS test connection — ${misType} @ ${endpoint}: ${testResult.ok ? "passed" : "failed"}.`,
    },
    { req },
  );

  const payload: TestMisConnectionResult = {
    ...testResult,
    misType,
    endpoint,
    tested_at: new Date().toISOString(),
  };

  return new ApiResponse(200, "MIS test connection", payload);
};
