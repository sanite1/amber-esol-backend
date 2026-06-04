/**
 * Maytas (Tribal) MIS adapter — Final Addendum §7, Phase 21.
 *
 * Implements `IMISAdapter` against the Tribal Maytas MIS.
 *
 * Status
 * ======
 *
 * **STUB.** Every method throws `NotImplementedError` until Joey
 * activates the adapter when the first Maytas-using customer signs.
 * The transport scaffolding (CSV generation + secure upload) is
 * sketched below as the realistic shape Maytas integrations
 * typically take, so when activation starts the conversation with
 * the customer's IT contact is concrete rather than greenfield.
 *
 * Why a stub and not a "throw on construction"
 * ============================================
 *
 * The MIS settings panel (Function 15 §7) lets an org admin select
 * "Maytas" from the dropdown today. Selecting it should NOT crash
 * the admin UI — the adapter constructs cleanly and surfaces a
 * clear `NotImplementedError` only when a real push or pull is
 * attempted. The error message is operator-readable; the pilot
 * deployment cadence's P1 flow treats it as a known-blocker (the
 * dropdown selection plus the error in the org-admin Slack
 * channel is the trigger for Joey to start activation below).
 *
 * Transport choice (planned)
 * ==========================
 *
 * Maytas historically ships two integration paths:
 *
 *   1. **SOAP API** — older Maytas deployments. Heavy XML, WSDL-
 *      driven client generation, narrow firewall allow-lists. Not
 *      our default; we'd only enable if the customer's deployment
 *      doesn't support path 2.
 *   2. **CSV upload via SFTP or signed S3** — the modern Tribal
 *      pattern, and the realistic MVP path. We generate a Maytas-
 *      shaped CSV per push, upload to the customer's drop point,
 *      and Maytas's own ingest job picks it up on its schedule.
 *
 * MVP plan: implement (2). Add (1) only if a customer needs it.
 *
 * Maytas DOES NOT commonly support a real-time learner-status pull.
 * `pullLearnerStatus` returning `null` post-activation is the right
 * answer — the delta-sync cron checks the result and skips Maytas-
 * backed orgs. Today the stub throws like every other method; the
 * activation steps below convert it to the null-returning shape.
 *
 * ─────────────────────────────────────────────────────────────────────
 * Activation steps (Joey runs these when first Maytas customer signs)
 * ─────────────────────────────────────────────────────────────────────
 *
 * 1. **Customer conversation with the customer's IT contact:**
 *    - Confirm Maytas version (affects SOAP-vs-CSV path).
 *    - Confirm preferred upload mechanism: SFTP (host, port, user,
 *      key) or signed S3 (bucket, prefix, IAM role).
 *    - Obtain the **CSV column specification** Maytas expects.
 *      Tribal publishes a "Maytas ILR Upload Specification" PDF —
 *      get the version that matches their deployment.
 *    - Confirm upload cadence: per-learner (one CSV per push,
 *      Maytas processes on next ingest) or daily-batched (one CSV
 *      per day with every learner). Per-learner is simpler; batched
 *      is more efficient at scale.
 *
 * 2. **Engineering: populate the field map** below
 *    (`MAYTAS_CSV_COLUMNS`) from the spec PDF. Mirror what the
 *    spec calls each column verbatim.
 *
 * 3. **Engineering: implement the upload helper**
 *    (`uploadCsv`). Pick SFTP or S3 based on the customer's
 *    preference. SFTP: use `ssh2-sftp-client`. S3: use the AWS SDK
 *    v3 `@aws-sdk/client-s3` + signed-URL flow if uploading from a
 *    third-party bucket.
 *
 * 4. **Engineering: replace the stub bodies** —
 *    `pushLearner`, `pushBatch`, and `pullLearnerStatus`. Keep the
 *    Pino logging contract identical to ProSolution
 *    (`provider: "Maytas"`).
 *
 * 5. **Engineering: integration test against the customer's
 *    sandbox** — Maytas customers typically have a sandbox
 *    environment that mirrors production. Push 5-10 fixture
 *    learners; confirm they land in the customer's sandbox MIS;
 *    confirm a deliberately-malformed CSV row triggers an MIS-side
 *    rejection that we surface as `{ success: false, error }`.
 *
 * 6. **Joey: sign-off conversation** with the customer's
 *    safeguarding / compliance lead. Confirm the upload mechanism
 *    keeps learner data in-region per UK GDPR (SFTP host in UK;
 *    S3 bucket in `eu-west-2`).
 *
 * 7. **Engineering: enable in production** — flip
 *    `Organisation.misType: "Maytas"` for the customer's org via
 *    the Function 15 §7 settings panel; the test-connection button
 *    on that panel exercises the activated adapter end-to-end.
 *
 * 8. **Joey: weekly check-in coverage** — confirm the first
 *    Maytas push reflects in the customer's MIS within their
 *    expected ingest window (usually next-day).
 *
 * 9. **Documentation:** update `docs/MIS_INTEGRATIONS.md` (to be
 *    authored at activation time) with the Maytas-specific
 *    quirks discovered during integration.
 *
 * 10. **Remove this header block.** Replace with a normal file
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
    "Maytas adapter awaiting first customer integration",
    "Maytas",
  );

// ─────────────────────────────────────────────────────────────────────
// CSV column spec — TBD per activation step 2
// ─────────────────────────────────────────────────────────────────────

/**
 * Maytas CSV column order + names. TODO(activation step 2): replace
 * the placeholder values with the verbatim column names from the
 * Tribal "Maytas ILR Upload Specification" the customer supplies.
 *
 * The keys are platform-side `MISRecord` field names; the values
 * are the Maytas CSV column headers. Column ORDER in the emitted
 * CSV follows the order of keys here — Maytas's ingest is
 * positional in some versions, so the order matters.
 */
const MAYTAS_CSV_COLUMNS: Array<{
  platformField: keyof Omit<MISRecord, "raw_payload">;
  csvHeader: string;
}> = [
  { platformField: "uln",                  csvHeader: "ULN" },                  // TODO confirm
  { platformField: "firstname",            csvHeader: "GivenNames" },           // TODO confirm
  { platformField: "lastname",             csvHeader: "FamilyName" },           // TODO confirm
  { platformField: "date_of_birth",        csvHeader: "DateOfBirth" },          // TODO confirm — format DD/MM/YYYY vs YYYY-MM-DD?
  { platformField: "esol_level",           csvHeader: "ESOLLevel" },            // TODO confirm
  { platformField: "learn_start_date",     csvHeader: "LearnStartDate" },       // TODO confirm
  { platformField: "learn_plan_end_date",  csvHeader: "LearnPlanEndDate" },     // TODO confirm
  { platformField: "learn_act_end_date",   csvHeader: "LearnActEndDate" },      // TODO confirm — empty cell or literal "NULL"?
  { platformField: "outcome",              csvHeader: "Outcome" },              // TODO confirm
  { platformField: "comp_status",          csvHeader: "CompStatus" },           // TODO confirm
  { platformField: "sof",                  csvHeader: "SOF" },                  // TODO confirm
  { platformField: "add_hours",            csvHeader: "AddHours" },             // TODO confirm
  { platformField: "english_prog_type",    csvHeader: "EnglishProgType" },      // TODO confirm
  { platformField: "total_glh",            csvHeader: "TotalGLH" },             // TODO confirm
  { platformField: "skill_codes_covered",  csvHeader: "SkillCodes" },           // TODO confirm — pipe-separated? comma in a single cell?
];

// ─────────────────────────────────────────────────────────────────────
// CSV helpers — pure, side-effect-free, callable from tests today
// ─────────────────────────────────────────────────────────────────────

/**
 * Escape a single cell value for CSV. RFC 4180 — wrap in quotes if
 * the value contains a comma, quote, or newline; double internal
 * quotes. Handles null + undefined as empty string.
 */
const csvCell = (value: unknown): string => {
  if (value === null || value === undefined) return "";
  let s: string;
  if (Array.isArray(value)) s = value.join("|");
  else if (typeof value === "object") s = JSON.stringify(value);
  else s = String(value);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
};

/**
 * Build a single CSV row in MAYTAS_CSV_COLUMNS order. Pure
 * function — tests can call this directly to verify the wire
 * format without standing up the adapter.
 */
const buildCsvRow = (record: MISRecord): string =>
  MAYTAS_CSV_COLUMNS.map((col) => {
    const value = (record as unknown as Record<string, unknown>)[
      col.platformField
    ];
    return csvCell(value);
  }).join(",");

/**
 * Build the full CSV body (header + rows). Pure function. The
 * activated push and batch methods both produce CSV via this
 * helper, differing only in row count.
 */
const buildCsv = (records: MISRecord[]): string => {
  const header = MAYTAS_CSV_COLUMNS.map((col) => csvCell(col.csvHeader)).join(",");
  const rows = records.map(buildCsvRow);
  return [header, ...rows].join("\n");
};

// ─────────────────────────────────────────────────────────────────────
// Upload helper — TBD per activation step 3
// ─────────────────────────────────────────────────────────────────────

/**
 * Upload a generated CSV to the customer's drop point. TODO
 * (activation step 3): pick SFTP or S3 based on the customer's
 * preference and implement.
 *
 * Returns a `provider_record_id`-like handle the customer's MIS
 * uses to acknowledge the file (often the filename itself).
 */
const uploadCsv = async (_csv: string, _filename: string): Promise<string> => {
  throw stubError();
};

// ─────────────────────────────────────────────────────────────────────
// Adapter class — stub bodies until activation
// ─────────────────────────────────────────────────────────────────────

export class MaytasAdapter implements IMISAdapter {
  private readonly endpoint: string;
  private readonly credentials: string;
  private readonly org_id: string;

  constructor(config: MISAdapterConfig) {
    if (!config.endpoint) {
      throw new Error("MaytasAdapter: endpoint is required");
    }
    if (!config.credentials) {
      throw new Error("MaytasAdapter: credentials are required");
    }
    if (!config.org_id) {
      throw new Error("MaytasAdapter: org_id is required");
    }
    // Construction succeeds today so the Function 15 §7 settings
    // panel doesn't error when an admin selects "Maytas". The
    // NotImplementedError fires at the FIRST push or pull attempt
    // and routes through the standard pilot-deployment-cadence P1
    // flow to Joey.
    this.endpoint = config.endpoint.replace(/\/+$/, "");
    this.credentials = config.credentials;
    this.org_id = config.org_id;
  }

  /**
   * Activation-time behaviour: probe the drop point's reachability
   * (SFTP login attempt, S3 bucket ListObjects with `prefix` +
   * `MaxKeys=1`). Returns `true` if the drop is reachable AND
   * writable by our credentials; `false` if reachable-but-not-
   * writable; throws on transport failure.
   *
   * Stub: throws NotImplementedError so the test-connection button
   * on the Function 15 §7 settings panel surfaces the activation
   * pointer.
   */
  async testConnection(): Promise<boolean> {
    logger.warn(
      { org_id: this.org_id, provider: "Maytas" },
      "Maytas testConnection invoked but adapter is a stub — see file header for activation steps",
    );
    throw stubError();
  }

  /**
   * Activation-time behaviour: build a single-row CSV via
   * `buildCsv([record])`, upload via `uploadCsv()`, return the
   * upload handle as `provider_record_id`.
   *
   * Stub: throws NotImplementedError. The Pino warn line below
   * fires before the throw so the failed-jobs dashboard captures
   * which `(org_id, uln)` triggered it.
   */
  async pushLearner(record: MISRecord): Promise<MISPushResult> {
    logger.warn(
      {
        org_id: this.org_id,
        provider: "Maytas",
        uln: record.uln,
        success: false,
      },
      "Maytas pushLearner invoked but adapter is a stub — see file header for activation steps",
    );
    throw stubError();
  }

  /**
   * Activation-time behaviour: build a multi-row CSV via
   * `buildCsv(records)`, upload once, return per-record results
   * derived from Maytas's ingest-status callback or polling. The
   * Maytas spec usually doesn't guarantee per-record granularity
   * in its response — if the customer's deployment is whole-file
   * accept/reject, every record gets the same envelope
   * (`success` mirrored across the array).
   *
   * Stub: throws NotImplementedError.
   */
  async pushBatch(records: MISRecord[]): Promise<MISPushResult[]> {
    logger.warn(
      {
        org_id: this.org_id,
        provider: "Maytas",
        batch_size: records.length,
        success: false,
      },
      "Maytas pushBatch invoked but adapter is a stub — see file header for activation steps",
    );
    throw stubError();
  }

  /**
   * Maytas does not commonly support a real-time learner-status
   * pull. Activation-time behaviour: this method will return
   * `null` for every ULN, and the delta-sync cron's Maytas branch
   * will skip the call entirely (gating on
   * `adapter.constructor.name === "MaytasAdapter"` or a capability
   * flag on the factory).
   *
   * Stub: throws NotImplementedError today so the activation
   * checklist hits this method explicitly and the team
   * consciously decides null vs an alternative shape (some
   * customers run a nightly Maytas → drop-point report we could
   * parse).
   */
  async pullLearnerStatus(
    uln: string,
  ): Promise<{ status: string; last_updated: string } | null> {
    logger.warn(
      { org_id: this.org_id, provider: "Maytas", uln },
      "Maytas pullLearnerStatus invoked but adapter is a stub — see file header for activation steps",
    );
    throw stubError();
  }
}

// ─────────────────────────────────────────────────────────────────────
// Factory — matches IMISAdapterFactory
// ─────────────────────────────────────────────────────────────────────

export const createMaytasAdapter = (config: MISAdapterConfig): IMISAdapter =>
  new MaytasAdapter(config);

// Re-export internals for tests + the activation team
export const __internals__ = {
  NotImplementedError,
  MAYTAS_CSV_COLUMNS,
  csvCell,
  buildCsvRow,
  buildCsv,
  uploadCsv,
};
