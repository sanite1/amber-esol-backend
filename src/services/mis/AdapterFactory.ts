/**
 * MIS adapter factory — Final Addendum §7, Phase 21.
 *
 * **The single entry point for instantiating an MIS adapter.**
 *
 * Push / pull code never instantiates `ProSolutionAdapter`,
 * `MaytasAdapter`, or `EBSAdapter` directly. Every code path that
 * needs to talk to an org's MIS goes through `getAdapter(org_id)`.
 * Centralising here gives us:
 *
 *   - **One credential-decryption path** — `decryptMisCredentials`
 *     is called from one place; tests + audits only have to assess
 *     one boundary.
 *   - **One MisType → concrete-adapter dispatch** — adding a new
 *     MIS (Phase 22+ may add Salesforce-derived or PICS) is a
 *     single-file change here, not a code-wide refactor.
 *   - **One MISNotConfiguredError surface** — every caller catches
 *     the same error class for "org has no MIS configured" and
 *     applies the same skip-cleanly semantics.
 *   - **Adapter instances are PER-CALL, not cached** — the factory
 *     re-reads + re-decrypts every time. That's deliberate: an
 *     admin rotating MIS credentials via the Function 15 §7
 *     settings panel takes effect on the next push without a
 *     process restart. Adapters carry no in-memory state worth
 *     caching anyway.
 *
 * Relationship to the existing Function 15 §7 stub registry
 * ========================================================
 *
 * `src/lib/misAdapters.ts` still serves the test-connection button
 * on the org-admin MIS settings panel (the panel constructs +
 * probes in one shot with caller-supplied credentials; doesn't
 * need to look the org up). This factory is the Phase 21 path
 * for production push / pull work. The two coexist; when the stub
 * registry is migrated, the settings panel will call this factory
 * with the just-saved credentials instead.
 */

import { Types } from "mongoose";
import ApiError from "../../errors/apiError";
import Organisation from "../../models/Organisation";
import { decryptMisCredentials } from "../../lib/misCredentials";
import logger from "../../config/logger";
import { createProSolutionAdapter } from "./ProSolutionAdapter";
import { createMaytasAdapter } from "./MaytasAdapter";
import { createEBSAdapter } from "./EBSAdapter";
import {
  IMISAdapter,
  IMISAdapterFactory,
  MISNotConfiguredError,
  MisType,
} from "./types";

// ─────────────────────────────────────────────────────────────────────
// Dispatch table — single source of truth for MisType → factory
// ─────────────────────────────────────────────────────────────────────

/**
 * Maps every real MIS type to its concrete factory. `"none"` is
 * deliberately absent — `getAdapter()` short-circuits on `"none"`
 * with a typed error before reaching this table.
 *
 * Adding a new MIS post-Phase 21: write the adapter file, add the
 * import above, add the entry here. No other changes needed.
 */
const FACTORY_BY_TYPE: Record<Exclude<MisType, "none">, IMISAdapterFactory> = {
  ProSolution: createProSolutionAdapter,
  Maytas: createMaytasAdapter,
  EBS: createEBSAdapter,
};

// ─────────────────────────────────────────────────────────────────────
// getAdapter — the entry point
// ─────────────────────────────────────────────────────────────────────

/**
 * Look up an org by id, validate its MIS configuration, decrypt
 * credentials, and return a ready-to-use adapter instance.
 *
 * Throws:
 *   - `ApiError(400)` — `org_id` is not a valid ObjectId
 *   - `ApiError(404)` — Organisation not found
 *   - `MISNotConfiguredError` (reason: "no_mis_type") —
 *     `misType` is "none" or absent
 *   - `MISNotConfiguredError` (reason: "no_endpoint") —
 *     `misType` is set but `misApiEndpoint` is empty
 *   - `MISNotConfiguredError` (reason: "no_credentials") —
 *     `misType` is set but `misApiCredentials` is null
 *   - any error from `decryptMisCredentials` (wrapped with
 *     context; usually means MIS_CREDENTIALS_KEY was rotated
 *     without re-encrypting stored values — see the runbook in
 *     `docs/PRODUCTION_DEPLOYMENT.md`)
 *
 * The caller decides how to treat each — typically the mis-push
 * worker swallows `MISNotConfiguredError` (skip this org cleanly)
 * and re-throws everything else to BullMQ's retry policy.
 */
export const getAdapter = async (org_id: string): Promise<IMISAdapter> => {
  // ── Input validation ────────────────────────────────────────────
  if (!org_id || !Types.ObjectId.isValid(org_id)) {
    throw new ApiError(400, "org_id must be a valid ObjectId");
  }

  // ── Load org ────────────────────────────────────────────────────
  // We need misType + misApiEndpoint + misApiCredentials. Projecting
  // explicitly so the ciphertext doesn't end up on any larger doc
  // the caller might log by accident.
  const org = await Organisation.findById(org_id)
    .select("_id misType misApiEndpoint misApiCredentials")
    .lean();
  if (!org) {
    throw new ApiError(404, "Organisation not found");
  }

  const misType = (org.misType ?? "none") as MisType;

  // ── Refuse "none" with the typed error ──────────────────────────
  // An MIS-unconfigured org is the default state, not a failure.
  // Callers catch this and skip cleanly. We log at debug level
  // (not warn) for the same reason — surfacing this at warn would
  // create noise on every cron pass over an unconfigured org.
  if (misType === "none") {
    logger.debug(
      { org_id, mis_type: misType },
      "getAdapter: org has no MIS configured (misType=none)",
    );
    throw new MISNotConfiguredError(
      org_id,
      "no_mis_type",
      `Organisation ${org_id} has no MIS configured (misType is "none").`,
    );
  }

  // ── Validate fields the concrete adapter requires ───────────────
  // We surface these as MISNotConfiguredError (NOT a generic
  // ApiError) so callers can distinguish "org needs setup" from
  // "real error" with one `instanceof` check.
  const endpoint = org.misApiEndpoint ?? "";
  if (endpoint.length === 0) {
    throw new MISNotConfiguredError(
      org_id,
      "no_endpoint",
      `Organisation ${org_id} has misType="${misType}" but no misApiEndpoint set.`,
    );
  }
  if (!org.misApiCredentials) {
    throw new MISNotConfiguredError(
      org_id,
      "no_credentials",
      `Organisation ${org_id} has misType="${misType}" but no stored credentials.`,
    );
  }

  // ── Decrypt credentials ─────────────────────────────────────────
  // `decryptMisCredentials` throws on malformed ciphertext (key
  // rotation without re-encrypting stored values). We let that
  // bubble — it's a real operational error the caller should see,
  // not a "skip cleanly" case.
  let credentials: string | null;
  try {
    credentials = decryptMisCredentials({
      misApiCredentials: org.misApiCredentials,
    });
  } catch (err) {
    logger.error(
      { err: (err as Error).message, org_id, mis_type: misType },
      "getAdapter: decrypt failed — likely MIS_CREDENTIALS_KEY rotation without re-encrypt",
    );
    throw err;
  }
  if (!credentials) {
    // Belt-and-braces — `decryptMisCredentials` returns null only
    // when the input is empty, which we already guarded above. If
    // we reach here, something has gone weird; treat as missing.
    throw new MISNotConfiguredError(
      org_id,
      "no_credentials",
      `Organisation ${org_id}: credentials decrypted to empty — re-enter via the MIS settings panel.`,
    );
  }

  // ── Dispatch ────────────────────────────────────────────────────
  // The cast on `misType` is safe because we've already rejected
  // "none" above; TypeScript can't narrow the union through the
  // earlier control-flow gate, hence the explicit cast.
  const factory = FACTORY_BY_TYPE[misType as Exclude<MisType, "none">];
  if (!factory) {
    // Shouldn't happen — every non-"none" MisType has a factory in
    // the dispatch table. If we reach here it's because someone
    // added a new MisType to the enum without registering its
    // factory. Surface a clear error so the gap is obvious.
    throw new Error(
      `getAdapter: no factory registered for misType="${misType}". ` +
        `Add it to FACTORY_BY_TYPE in src/services/mis/AdapterFactory.ts.`,
    );
  }

  return factory({
    endpoint,
    credentials,
    org_id,
  });
};

// Re-export for tests
export const __internals__ = { FACTORY_BY_TYPE };
