/**
 * MIS adapter registry — Final Addendum §7 + §21.
 *
 * The full ProSolution / Maytas / EBS push adapters land in Phase 21.
 * This file is the registry interface they all conform to + a stub
 * `testConnection()` for each one so the Admin → MIS settings panel
 * can render the "Test connection" button today.
 *
 * Contract for adapters
 * =====================
 *
 *   testConnection(endpoint, credentials): Promise<MisTestResult>
 *     - Open whatever the MIS treats as a no-op auth probe (an OPTIONS
 *       request, a GET against a health endpoint, a 0-row push, etc).
 *     - Return a structured success / failure result. Never throw for
 *       a wrong-credentials response — that's still "expected" outcome
 *       data, not an exception.
 *     - Time-bound the probe (5–10 s) — a stuck MIS endpoint must NOT
 *       hang the admin route.
 *
 * Why a stub and not a "not implemented" 501
 * ==========================================
 *
 * A 501 would force the frontend into a special-case error path. By
 * returning a structured `MisTestResult` with `ok: false` and a
 * clearly-labelled reason, the UI can render the same "test failed"
 * banner Phase 21's real adapters will render — only the message
 * changes. Once Phase 21 lands, we swap each stub for the real
 * adapter without touching the route or the page.
 */

export type MisType = "ProSolution" | "Maytas" | "EBS" | "none";

export interface MisTestResult {
  /** True when the MIS responded affirmatively to the probe. */
  ok: boolean;
  /**
   * Short, human-readable summary. Surfaced verbatim in the admin UI
   * — keep it plain English (no stack traces, no credential echoes).
   */
  message: string;
  /**
   * Optional metadata the UI can render below the message — adapter
   * version, MIS-side endpoint version, probe duration, etc. Never
   * include credentials or any echo of the request body.
   */
  details?: Record<string, string | number | boolean | null>;
}

export interface MisAdapter {
  type: MisType;
  testConnection: (input: {
    endpoint: string;
    credentials: string;
  }) => Promise<MisTestResult>;
}

// ─────────────────────────────────────────────────────────────────────
// Stub implementations — Phase 21 swaps these for real adapters
// ─────────────────────────────────────────────────────────────────────

const stubAdapter = (type: Exclude<MisType, "none">): MisAdapter => ({
  type,
  testConnection: async ({ endpoint }) => {
    // Cheap input sanity so the UI gets immediate feedback for the
    // common typo cases without an HTTP round-trip.
    if (!endpoint) {
      return {
        ok: false,
        message: "MIS endpoint URL is empty.",
      };
    }
    try {
      // Validate the URL parses — catches "prosolution.example.com"
      // (no scheme) early. We don't actually hit the network for the
      // stub; Phase 21's real adapter will.
      new URL(endpoint);
    } catch {
      return {
        ok: false,
        message: `MIS endpoint URL is not a valid URL: ${endpoint}`,
      };
    }
    return {
      ok: false,
      message: `${type} adapter not yet implemented (Phase 21).`,
      details: {
        endpoint_parsed_ok: true,
        adapter_status: "stub",
      },
    };
  },
});

const REGISTRY: Record<Exclude<MisType, "none">, MisAdapter> = {
  ProSolution: stubAdapter("ProSolution"),
  Maytas: stubAdapter("Maytas"),
  EBS: stubAdapter("EBS"),
};

/**
 * Returns the adapter for a given misType. Null for "none" (no MIS
 * connected) — callers should treat that as "nothing to test", not
 * an error.
 */
export const getMisAdapter = (type: MisType): MisAdapter | null => {
  if (type === "none") return null;
  return REGISTRY[type] ?? null;
};

/** All supported MIS types — useful for the Joi enum. */
export const ALL_MIS_TYPES: ReadonlyArray<MisType> = [
  "ProSolution",
  "Maytas",
  "EBS",
  "none",
] as const;
