/**
 * MIS adapter contracts — Final Addendum §7, Phase 21.
 *
 * Each MIS Amber integrates with (ProSolution, Maytas, EBS) lands as a
 * concrete class implementing `IMISAdapter`. The contracts here are the
 * single source of truth — service code, the queue processors, and the
 * delta-sync cron all type their boundaries against this file.
 *
 * Relation to `src/lib/misAdapters.ts`
 * ====================================
 *
 * The existing `lib/misAdapters.ts` file ships a thin **stub registry**
 * built during the Function 15 §7 admin settings UI work. Its
 * `MisAdapter` interface differs from `IMISAdapter` here — the stub
 * accepts `(endpoint, credentials)` at every method call because the
 * settings panel constructs and probes in one shot.
 *
 * The `IMISAdapter` contract in this file is the Phase 21 evolution:
 * adapters are instantiated WITH connection params, then probed +
 * mutated through their methods. When Phase 21's concrete adapters
 * land, the stub registry will be migrated to instantiate them per
 * the factory contract below.
 *
 * Until then, both files coexist:
 * - `lib/misAdapters.ts` — what the test-connection button calls today.
 * - `services/mis/*` — the contract the real adapters implement.
 */

import type { MisType } from "../../lib/misAdapters";
export type { MisType };

// ─────────────────────────────────────────────────────────────────────
// MISRecord — the platform-side normalised shape every MIS push uses
// ─────────────────────────────────────────────────────────────────────

/**
 * The canonical learner record passed to an MIS adapter. Field names
 * mirror the ILR export (Function 13) so the same upstream builder
 * can populate either an ESFA submission or an MIS push without a
 * second translation pass.
 *
 * Provider-specific extras (e.g. ProSolution's internal `learner_ref`
 * or EBS's custom-defined fields) live under `raw_payload`. The
 * typed-fields-plus-escape-hatch shape is deliberate: the typed
 * surface guarantees the audit + compliance properties we need,
 * while `raw_payload` accommodates the wild variance between MIS
 * vendors without forcing the typed shape to grow.
 */
export interface MISRecord {
  /** Unique Learner Number — 10 digits, ESFA-issued, primary key for every MIS. */
  uln: string;
  firstname: string;
  lastname: string;
  /** ISO 8601 date (YYYY-MM-DD). */
  date_of_birth: string;
  /** Lower-case literal: "e1" | "e2" | "e3" | "l1" | "l2". */
  esol_level: string;
  /** ISO 8601 date — when the learner started this learning aim. */
  learn_start_date: string;
  /** ISO 8601 date — planned end of this aim. */
  learn_plan_end_date: string;
  /** ISO 8601 date — actual end, or null if the aim is still in progress. */
  learn_act_end_date: string | null;
  /**
   * ESFA Outcome code. Validation rules + valid value list live in
   * ComplianceConfig (`ilr` domain) — never hardcoded here.
   */
  outcome: number;
  /**
   * ESFA Completion Status code. Same ComplianceConfig source as outcome.
   */
  comp_status: number;
  /** Source of Funding code (ESFA SOF). */
  sof: string;
  /** Additional guided learning hours (carry-forward from pre-platform). */
  add_hours: number;
  /**
   * EnglishProgType. 2025/26 breaking change — codes may be alphanumeric.
   * The ILR breaking-change handler normalises; the adapter receives the
   * post-handler value.
   */
  english_prog_type: string;
  /** Total guided learning hours for this aim. */
  total_glh: number;
  /** ForSkills / ILR skill codes covered (Sc, Sd, Lr, Rt, Rs, Rw, Wt, Ws, Ww). */
  skill_codes_covered: string[];
  /**
   * Escape hatch for adapter-specific extras. `any` is deliberate
   * here — the typed surface above is what callers code against;
   * `raw_payload` is the deliberately untyped place for whatever the
   * underlying MIS vendor needs that doesn't fit the typed shape.
   * The brief asks for this shape verbatim.
   */
  raw_payload: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

// ─────────────────────────────────────────────────────────────────────
// MISPushResult — the structured response from a push call
// ─────────────────────────────────────────────────────────────────────

/**
 * Per-record result envelope. `success: true` requires a non-empty
 * `provider_record_id`; `success: false` requires a non-empty `error`.
 * `warnings` is for "the push went through but here's something the
 * MIS flagged" cases — used by the audit log to record any soft
 * compliance flags raised at push time.
 */
export interface MISPushResult {
  success: boolean;
  /** The MIS's own id for the persisted row. Used by `pullLearnerStatus`. */
  provider_record_id?: string;
  /** Plain-English error string. Surfaced to the org admin on failure. */
  error?: string;
  /** Soft warnings — push succeeded but the MIS flagged something. */
  warnings?: string[];
}

// ─────────────────────────────────────────────────────────────────────
// IMISAdapter — the contract every concrete MIS implements
// ─────────────────────────────────────────────────────────────────────

/**
 * Connection params an adapter is constructed with. Credentials arrive
 * here as PLAINTEXT — the caller (Phase 21 service layer) is responsible
 * for `decryptMisCredentials()` before instantiation. Storing the
 * plaintext on the adapter is acceptable because adapter instances are
 * scoped per push operation; they don't live in the process beyond
 * the request that created them.
 */
export interface MISAdapterConfig {
  endpoint: string;
  credentials: string;
  /** Org context for logging + audit. */
  org_id: string;
}

export interface IMISAdapter {
  /**
   * Authenticated reachability probe. Returns true if the MIS accepts
   * the supplied credentials AND responds. Returns false on
   * "credentials valid but the MIS rejected the probe for other
   * reasons" (e.g. account suspended). Throws on transport failure
   * (network down, DNS resolution failure) — callers treat the throw
   * as "we couldn't determine reachability".
   */
  testConnection(): Promise<boolean>;

  /**
   * Push one learner. Returns the result envelope; never throws on
   * a graded MIS failure (401 / 4xx / 5xx-after-retry) — those flow
   * back as `{ success: false, error }`. The only exceptions that
   * escape are `MISAuthError` (the MIS rejected our credentials —
   * subsequent calls will also fail; the caller's pipeline should
   * stop) and `MISServerError` (the MIS is down — retry the whole
   * batch later).
   */
  pushLearner(record: MISRecord): Promise<MISPushResult>;

  /**
   * Push up to 100 learners in one MIS call. Adapters chunk
   * internally if the caller hands over more than the per-vendor
   * limit. Returns one result envelope per input record, in input
   * order, so the caller can correlate failures back to the source
   * row.
   */
  pushBatch(records: MISRecord[]): Promise<MISPushResult[]>;

  /**
   * Pull the MIS's current status for one ULN. Used by the
   * delta-sync cron (Phase 1.C `delta-sync` queue) to detect when an
   * MIS has updated a learner outside the platform — e.g. the
   * provider's admin marked a learner as "withdrawn" in
   * ProSolution directly. The cron then mirrors that state back
   * into Mongo.
   *
   * Returns `null` when the MIS doesn't know the ULN (404 / not
   * found). That's a normal case, not an error — it usually means
   * the learner hasn't been pushed yet.
   */
  pullLearnerStatus(uln: string): Promise<{
    status: string;
    last_updated: string;
  } | null>;
}

// ─────────────────────────────────────────────────────────────────────
// Factory contract — how Phase 21 instantiates adapters from settings
// ─────────────────────────────────────────────────────────────────────

/**
 * Each concrete adapter file exports a class implementing
 * `IMISAdapter` AND a default factory function with this signature.
 * The service layer reads `Organisation.misType`, decrypts the
 * credentials, then calls the matching factory to get a usable
 * adapter instance for the current request.
 */
export type IMISAdapterFactory = (config: MISAdapterConfig) => IMISAdapter;

// ─────────────────────────────────────────────────────────────────────
// Error classes — thrown by adapters on hard failures
// ─────────────────────────────────────────────────────────────────────

/**
 * The MIS rejected our credentials (HTTP 401). Subsequent calls with
 * the same credentials will fail identically — the caller's pipeline
 * should stop and surface a "re-enter credentials" prompt to the
 * org admin via the Function 15 §7 MIS settings panel.
 */
export class MISAuthError extends Error {
  readonly provider: MisType;
  readonly org_id: string;
  constructor(provider: MisType, org_id: string, message: string) {
    super(message);
    this.name = "MISAuthError";
    this.provider = provider;
    this.org_id = org_id;
  }
}

/**
 * The MIS is having a server-side problem (HTTP 5xx) and a single
 * retry didn't recover. The caller (typically the mis-push BullMQ
 * worker) treats this as a retryable failure — BullMQ's own retry
 * policy schedules the next attempt; the FailedJob collection
 * captures the row after exhausted retries so the admin failed-jobs
 * dashboard surfaces it.
 */
export class MISServerError extends Error {
  readonly provider: MisType;
  readonly org_id: string;
  readonly http_status?: number;
  constructor(
    provider: MisType,
    org_id: string,
    message: string,
    http_status?: number,
  ) {
    super(message);
    this.name = "MISServerError";
    this.provider = provider;
    this.org_id = org_id;
    this.http_status = http_status;
  }
}

/**
 * Thrown by `AdapterFactory.getAdapter()` when the org has no MIS
 * configured — either `misType === "none"`, or it's set to a real
 * type but `misApiEndpoint` / `misApiCredentials` is empty.
 *
 * The caller (typically the mis-push worker or a service-layer
 * function) is expected to catch this and treat it as "skip this
 * org cleanly" rather than a failure. It is NOT a bug for an org
 * to be MIS-unconfigured — it's the default state.
 */
export class MISNotConfiguredError extends Error {
  readonly org_id: string;
  readonly reason: "no_mis_type" | "no_endpoint" | "no_credentials";
  constructor(
    org_id: string,
    reason: "no_mis_type" | "no_endpoint" | "no_credentials",
    message: string,
  ) {
    super(message);
    this.name = "MISNotConfiguredError";
    this.org_id = org_id;
    this.reason = reason;
  }
}

/**
 * Thrown when a stubbed adapter method is invoked. Carries the
 * provider name so an operator triaging a Sentry event can find
 * the right adapter file's activation header and proceed.
 *
 * Lifted here from `MaytasAdapter.ts` once `EBSAdapter` also needed
 * the class — two stub adapters sharing the same local class is
 * the duplication trigger. When both Maytas and EBS ship real
 * implementations, this class can be deleted.
 */
export class NotImplementedError extends Error {
  readonly provider: string;
  constructor(message: string, provider: string) {
    super(message);
    this.name = "NotImplementedError";
    this.provider = provider;
  }
}
