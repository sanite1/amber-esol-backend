/**
 * EBS (Capita) MIS adapter — Final Addendum §7, Phase 21.
 *
 * Implements `IMISAdapter` against Capita's EBS (Education Business
 * System).
 *
 * Status
 * ======
 *
 * **STUB.** Every method throws `NotImplementedError` until Joey
 * activates the adapter when the first EBS-using customer signs.
 * Same pattern as `MaytasAdapter` — construction succeeds so the
 * Function 15 §7 settings panel can offer "EBS" as a dropdown
 * option today; the activation pointer fires on the first push or
 * pull attempt.
 *
 * Why EBS is different from ProSolution + Maytas
 * ==============================================
 *
 * EBS is a proprietary Capita integration. Unlike ProSolution
 * (modern REST) or Maytas (CSV drop-point), EBS integrations
 * historically take one of three shapes:
 *
 *   1. **Capita-supplied middleware** — Capita installs a
 *      "Connector" service inside the customer's network that
 *      polls our outbound queue and pushes into EBS over Capita's
 *      proprietary protocol. We push to the connector via a REST
 *      API the connector exposes locally.
 *   2. **Capita's hosted Integration Service** — Capita runs the
 *      bridge themselves; we hit a Capita-hosted REST endpoint
 *      with customer-tenanted credentials. Available on newer
 *      EBS deployments.
 *   3. **Direct DLL / SDK integration** — older deployments. The
 *      customer's IT team installs a Capita SDK on their server
 *      and exposes a thin local HTTP wrapper we hit. Rare on
 *      modern installs but still seen at long-tenure colleges.
 *
 * Path 2 is the modern default and what we'd prefer. Path 1 is the
 * common reality. Path 3 we'd refuse unless absolutely necessary
 * (operational overhead is high).
 *
 * Crucially: **EBS integrations require Capita partnership
 * involvement.** You can't activate this adapter just by talking
 * to the customer's IT team — Capita's Integration Partner team
 * has to enable the integration on their side (path 1 / 2) or
 * supply the SDK + licence keys (path 3). That conversation
 * typically takes 4-8 weeks. Schedule accordingly.
 *
 * ─────────────────────────────────────────────────────────────────────
 * Activation steps (Joey runs these when first EBS customer signs)
 * ─────────────────────────────────────────────────────────────────────
 *
 * 1. **Capita partnership conversation FIRST** — before any
 *    customer-side conversation, contact Capita's Integration
 *    Partner team and:
 *    - Confirm Amber Training Ltd as an approved integration
 *      partner. Capita maintains an allow-list; first-time
 *      partners need to be registered (typically a 2-4 week
 *      process).
 *    - Confirm which integration path the customer's EBS
 *      deployment supports (1 / 2 / 3 above).
 *    - Obtain the **EBS Integration Specification** for the
 *      chosen path. Capita publishes per-path specs; the API
 *      surface differs materially.
 *
 * 2. **Customer conversation:**
 *    - Confirm their EBS version (Capita's spec varies by major
 *      version — v7 vs v8 fields differ).
 *    - Confirm the integration path picked in step 1 is
 *      available on their deployment.
 *    - Obtain credentials. Path 1: connector URL + shared
 *      secret. Path 2: Capita tenant id + API key. Path 3: SDK
 *      licence key + the customer's wrapper URL.
 *    - Confirm Capita's involvement is sponsored — the customer
 *      typically pays Capita a per-integration fee on top of
 *      their EBS licence.
 *
 * 3. **Engineering: populate the field map** below
 *    (`EBS_FIELD_MAP`) from the spec for the chosen path. EBS
 *    field names are Capita-defined and don't match ProSolution
 *    or Maytas — assume zero overlap.
 *
 * 4. **Engineering: implement the transport** based on the
 *    chosen path:
 *    - Path 1: REST against the customer-side connector. Looks
 *      structurally similar to `ProSolutionAdapter.ts` — copy
 *      the `httpRequest` helper there and adapt.
 *    - Path 2: REST against Capita's hosted endpoint. Same
 *      shape as path 1, different URL + auth header (Capita
 *      uses `X-Capita-Tenant` + `X-Capita-Api-Key`).
 *    - Path 3: REST against the customer's SDK wrapper. Same
 *      shape but the wrapper's URL is on the customer's
 *      internal network — we'd need either a VPN or a customer-
 *      side reverse proxy. Refuse unless the customer can
 *      provide a public endpoint.
 *
 * 5. **Engineering: replace the four stub bodies** —
 *    `testConnection`, `pushLearner`, `pushBatch`,
 *    `pullLearnerStatus`. Keep the Pino logging contract
 *    identical to ProSolution (`provider: "EBS"`).
 *
 * 6. **Capita-coordinated integration test** — Capita's
 *    Integration Partner team typically wants to observe the
 *    first end-to-end push against the customer's sandbox EBS
 *    deployment. Schedule a call; push 5-10 fixture learners;
 *    Capita validates on their side; we confirm the records
 *    surface in the customer's EBS UI.
 *
 * 7. **Joey: sign-off conversation** with the customer's
 *    safeguarding / compliance lead AND Capita. Confirm:
 *    - Learner data stays in-region per UK GDPR (Capita's
 *      hosted endpoints are EU-hosted by default; confirm
 *      explicitly).
 *    - Capita's audit trail is enabled — Capita logs every
 *      integration call on their side; this is a regulatory
 *      requirement for FE colleges and a useful complement to
 *      our own audit log.
 *
 * 8. **Engineering: enable in production** — flip
 *    `Organisation.misType: "EBS"` via the Function 15 §7
 *    settings panel; the test-connection button exercises the
 *    activated adapter end-to-end.
 *
 * 9. **Joey: weekly check-in coverage** — confirm the first
 *    EBS push surfaces in the customer's EBS UI within the
 *    expected window (Capita's hosted path is typically
 *    near-realtime; the connector path can lag by minutes).
 *
 * 10. **Documentation:** update `docs/MIS_INTEGRATIONS.md`
 *     with the path picked + the Capita-specific quirks
 *     discovered during integration.
 *
 * 11. **Remove this header block.** Replace with a normal file
 *     header once activation is complete.
 */

import logger from "../../config/logger";
import {
  IMISAdapter,
  MISAdapterConfig,
  MISPushResult,
  MISRecord,
  NotImplementedError,
} from "./types";

// Convenience wrapper so call sites don't repeat the provider name.
const stubError = () =>
  new NotImplementedError(
    "EBS adapter awaiting first customer integration",
    "EBS",
  );

// ─────────────────────────────────────────────────────────────────────
// Field map — TBD per activation step 3
// ─────────────────────────────────────────────────────────────────────

/**
 * EBS wire field names. TODO(activation step 3): populate from the
 * EBS Integration Specification Capita supplies for the chosen
 * path. EBS field names are Capita-defined; assume zero overlap
 * with ProSolution or Maytas.
 *
 * Path 1 (customer-side connector) and Path 2 (Capita-hosted)
 * typically share the field names — only the transport differs.
 * Path 3 (direct SDK) is sometimes a different schema; if the
 * customer requires path 3, copy this map and version per-path.
 */
const EBS_FIELD_MAP: Record<keyof Omit<MISRecord, "raw_payload">, string> = {
  uln: "uln", // TODO confirm — EBS often uses lowercase + underscores
  firstname: "given_name", // TODO confirm
  lastname: "family_name", // TODO confirm
  date_of_birth: "dob", // TODO confirm — ISO 8601 expected
  esol_level: "qualification_level", // TODO confirm — EBS uses "qualification" not "ESOL"
  learn_start_date: "enrollment_date", // TODO confirm
  learn_plan_end_date: "expected_end_date", // TODO confirm
  learn_act_end_date: "actual_end_date", // TODO confirm
  outcome: "outcome_code", // TODO confirm
  comp_status: "completion_status_code", // TODO confirm
  sof: "funding_source", // TODO confirm — EBS uses long-form
  add_hours: "additional_hours", // TODO confirm
  english_prog_type: "english_program_type", // TODO confirm
  total_glh: "total_guided_learning_hours", // TODO confirm
  skill_codes_covered: "skills_covered", // TODO confirm — array shape?
};

/**
 * Build the wire payload from a `MISRecord`. Pure function —
 * tests can exercise the mapping directly once activation
 * populates the field map. `raw_payload` is merged LAST so
 * adapter-specific extras can override the typed fields
 * (escape hatch for Capita's per-customer custom fields).
 */
const toEBSPayload = (record: MISRecord): Record<string, unknown> => {
  const payload: Record<string, unknown> = {};
  for (const [platformField, wireField] of Object.entries(EBS_FIELD_MAP)) {
    const value = (record as unknown as Record<string, unknown>)[platformField];
    if (value !== undefined) payload[wireField] = value;
  }
  if (record.raw_payload && typeof record.raw_payload === "object") {
    Object.assign(payload, record.raw_payload);
  }
  return payload;
};

// ─────────────────────────────────────────────────────────────────────
// Adapter class — stub bodies until activation
// ─────────────────────────────────────────────────────────────────────

export class EBSAdapter implements IMISAdapter {
  private readonly endpoint: string;
  private readonly credentials: string;
  private readonly org_id: string;

  constructor(config: MISAdapterConfig) {
    if (!config.endpoint) {
      throw new Error("EBSAdapter: endpoint is required");
    }
    if (!config.credentials) {
      throw new Error("EBSAdapter: credentials are required");
    }
    if (!config.org_id) {
      throw new Error("EBSAdapter: org_id is required");
    }
    // Construction succeeds today so the Function 15 §7 settings
    // panel doesn't error when an admin selects "EBS". The
    // NotImplementedError fires at the first push or pull attempt
    // and routes through the standard pilot-deployment-cadence P1
    // flow to Joey.
    this.endpoint = config.endpoint.replace(/\/+$/, "");
    this.credentials = config.credentials;
    this.org_id = config.org_id;
  }

  /**
   * Activation-time behaviour: probe the chosen-path endpoint:
   * - Path 1: GET against the connector's `/health` (Capita's
   *   spec).
   * - Path 2: GET against Capita's tenant probe endpoint with
   *   the tenant id header.
   * - Path 3: GET against the SDK wrapper's status endpoint.
   *
   * All three return 200 on healthy + credentials valid, 401 on
   * bad credentials. Behaviour mirrors ProSolution.
   *
   * Stub: throws NotImplementedError so the test-connection
   * button on the Function 15 §7 settings panel surfaces the
   * activation pointer.
   */
  async testConnection(): Promise<boolean> {
    logger.warn(
      { org_id: this.org_id, provider: "EBS" },
      "EBS testConnection invoked but adapter is a stub — see file header for activation steps",
    );
    throw stubError();
  }

  /**
   * Activation-time behaviour: POST the EBS-shaped payload to
   * the chosen-path endpoint. EBS returns a Capita-internal
   * record id we map to `provider_record_id`.
   *
   * Stub: throws NotImplementedError. The Pino warn line fires
   * BEFORE the throw so the failed-jobs dashboard captures which
   * `(org_id, uln)` triggered it.
   */
  async pushLearner(record: MISRecord): Promise<MISPushResult> {
    logger.warn(
      {
        org_id: this.org_id,
        provider: "EBS",
        uln: record.uln,
        success: false,
      },
      "EBS pushLearner invoked but adapter is a stub — see file header for activation steps",
    );
    throw stubError();
  }

  /**
   * Activation-time behaviour: EBS supports batch on path 1 +
   * path 2 (typically up to 500 records per call — Capita's
   * limit is higher than ProSolution's 100 because the
   * Capita-hosted endpoint is heavier-weight infra). Path 3 may
   * not support batch; fall back to per-record `pushLearner`
   * calls in a loop.
   *
   * Per-record results come back in the EBS response keyed by
   * ULN — same shape as ProSolution. Re-order to input order
   * before returning.
   *
   * Stub: throws NotImplementedError.
   */
  async pushBatch(records: MISRecord[]): Promise<MISPushResult[]> {
    logger.warn(
      {
        org_id: this.org_id,
        provider: "EBS",
        batch_size: records.length,
        success: false,
      },
      "EBS pushBatch invoked but adapter is a stub — see file header for activation steps",
    );
    throw stubError();
  }

  /**
   * Activation-time behaviour: EBS supports learner-status pull
   * on all three paths (unlike Maytas). GET against
   * `/learners/{uln}` with the path-appropriate auth headers.
   * 404 → `null`; otherwise return the EBS-reported status +
   * last-updated timestamp.
   *
   * This is the call the delta-sync cron makes — when a college
   * admin marks a learner as "transferred" or "withdrawn" in
   * EBS directly, the cron sees the change and mirrors it back
   * into Mongo.
   *
   * Stub: throws NotImplementedError.
   */
  async pullLearnerStatus(
    uln: string,
  ): Promise<{ status: string; last_updated: string } | null> {
    logger.warn(
      { org_id: this.org_id, provider: "EBS", uln },
      "EBS pullLearnerStatus invoked but adapter is a stub — see file header for activation steps",
    );
    throw stubError();
  }
}

// ─────────────────────────────────────────────────────────────────────
// Factory — matches IMISAdapterFactory
// ─────────────────────────────────────────────────────────────────────

export const createEBSAdapter = (config: MISAdapterConfig): IMISAdapter =>
  new EBSAdapter(config);

// Re-export internals for tests + the activation team
export const __internals__ = {
  EBS_FIELD_MAP,
  toEBSPayload,
  stubError,
};
