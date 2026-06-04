/**
 * ═══════════════════════════════════════════════════════════════════════
 * ForSkills (NCFE) Live API Client — STUB (brief Function 4 Phase B)
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Status: NOT IMPLEMENTED. CSV upload (Function 4 Phase A) is the live
 * path; this file is a placeholder for the v1.1 API integration.
 *
 * ─── Vendor contact ────────────────────────────────────────────────────
 *   NCFE ForSkills team: skillsassessments@ncfe.org.uk
 *   Project lead chasing this:  Joey @ Amber Training
 *
 * ─── What Joey is requesting ───────────────────────────────────────────
 *   1. A sample ForSkills CSV export (.csv from the production tenant,
 *      not a docs page) so we can confirm the exact column headers,
 *      casing, and date / score formats. Today we're guessing — the
 *      8 fields in `ForSkillsLearnerRecord` below are educated
 *      placeholders, not authoritative.
 *   2. The complete field list — including any per-ILR-sub-skill scores
 *      (Rt / Rs / Rw / Wt / Ws / Ww / Lr / Sc / Sd) that ForSkills
 *      computes internally. Phase A fans the domain score onto all child
 *      codes; Phase B should ingest per-code scores directly when
 *      available.
 *   3. Commercial terms for programmatic API access:
 *        - Authentication scheme (API key, OAuth client credentials,
 *          mTLS — NCFE confirm)
 *        - Rate limits + concurrency caps
 *        - Per-call vs flat-fee pricing
 *        - Sandbox / UAT tenant for development
 *        - Data residency (UK-only is required — ESFA contract)
 *   4. Webhook support — push assessments to us, vs us pulling on a
 *      schedule. A webhook eliminates the cron and matches how the
 *      org admin's mental model already works ("learner just finished
 *      ForSkills, why isn't it in Amber yet?").
 *
 * ─── What happens when credentials arrive ──────────────────────────────
 *   1. Drop the live REST client into `syncForSkillsForOrg` below.
 *      Use the existing `lib/network/` utilities for retries + auth;
 *      surface NCFE-side failures as `ApiError(502, ...)` with the
 *      vendor's request-id so support can correlate.
 *   2. Map the vendor's response shape onto the existing
 *      `applyToLearner` flow in `orgAdminForskillsImport.service.ts` —
 *      do NOT duplicate the validation/audit/flag-merge logic. The
 *      CSV importer already does all of that; the API client just
 *      replaces the streamRows() input.
 *   3. Add an env-var feature flag (e.g. `FORSKILLS_API_ENABLED`) so
 *      the CSV path remains available as a fallback during the
 *      transition window.
 *   4. Wire a BullMQ recurring job (the `delta-sync` queue already
 *      exists, see Final Addendum §1) to call `syncForSkillsForOrg`
 *      per org on a schedule confirmed with NCFE — likely nightly or
 *      4-hourly depending on their freshness guarantees.
 *   5. Frontend: replace the CSV upload affordance on the org admin
 *      dashboard with a "Sync from ForSkills" button that triggers the
 *      sync and polls job status. The CSV upload page stays as a
 *      fallback (visible behind a "Manual upload" link) for orgs
 *      without a ForSkills licence.
 *   6. Move the contact details + status note above into a deprecation
 *      banner on the CSV upload page so org admins know which is canon.
 *
 * ─── Don't ─────────────────────────────────────────────────────────────
 *   - Don't add any real network code until NCFE confirms the contract.
 *     Premature mocking against guessed endpoints creates lock-in to a
 *     shape that won't match production.
 *   - Don't expose this function from any route, controller, or queue
 *     consumer until it's implemented. The NotImplementedError keeps it
 *     dead-loud — a stray caller will throw, not silently no-op.
 * ═══════════════════════════════════════════════════════════════════════
 */

/**
 * Thrown when an intentionally-unimplemented code path is invoked.
 * Distinct from `ApiError(501)` because it isn't an HTTP-shaped error —
 * if this leaks past the boundary it's a programming bug, not a 501
 * to surface to the user.
 */
export class NotImplementedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotImplementedError";
  }
}

/**
 * One learner row as it WILL appear on the wire once NCFE publishes the
 * contract. Field names mirror the Phase A CSV columns; types are best-
 * guesses pending NCFE's response.
 *
 * Open questions baked into the placeholder:
 *   - `entry_level` / `recommended_level`: ESOL level codes like "e2",
 *     or NCFE's internal level IDs?
 *   - `*_score`: 0–100 percentage, or a raw points value?
 *   - `assessment_date`: ISO date-only ("YYYY-MM-DD"), full ISO 8601
 *     timestamp, or a UK-format string?
 *   - `uln`: optional? Always present for UK learners? Empty string vs
 *     null when not supplied?
 *
 * Each open question resolves to a one-line type tweak once we have
 * the sample export — kept loose on purpose to avoid premature
 * narrowing.
 */
export interface ForSkillsLearnerRecord {
  learner_ref: string;
  assessment_date: string;
  entry_level: string;
  reading_score: number;
  writing_score: number;
  listening_score: number;
  speaking_score: number;
  recommended_level: string;
  uln?: string;
}

/**
 * Per-org outcome of a ForSkills sync run.
 *
 * `synced` counts learners successfully matched and updated; `errors`
 * collects per-record failures in the same shape Function 4 Phase A
 * returns so the org admin sees one consistent error UI regardless of
 * whether the data arrived via CSV or API.
 *
 * When implemented: do NOT throw on partial failures. The org admin
 * needs to see exactly which learners didn't sync. Mirror the
 * partial-success pattern from `importLearnersService`.
 */
export interface SyncForSkillsResult {
  synced: number;
  errors: { record?: ForSkillsLearnerRecord; field: string; message: string }[];
}

/**
 * Pull all available ForSkills assessment records for the given org,
 * apply them via the same `applyToLearner` machinery the CSV importer
 * uses, and return a summary.
 *
 * @throws NotImplementedError until NCFE credentials land.
 */
export const syncForSkillsForOrg = async (
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  org_id: string
): Promise<SyncForSkillsResult> => {
  throw new NotImplementedError(
    "ForSkills API integration awaiting NCFE credentials — ETA v1.1"
  );
};
