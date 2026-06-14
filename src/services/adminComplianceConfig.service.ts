/**
 * Admin ComplianceConfig route-layer service — Final Addendum §3.
 *
 * Three flows backed:
 *
 *   GET  /api/admin/compliance-config                       listAllConfigsService
 *   GET  /api/admin/compliance-config/:domain/:academicYear/active
 *                                                          getActiveConfigService
 *   POST /api/admin/compliance-config                       activateConfigService
 *
 * Heavy lifting (the deactivate-old / create-new / reload-cache
 * transaction) already lives in ComplianceConfigService.update();
 * this layer wraps it with:
 *
 *   - Joi-style input validation at the service boundary
 *   - AuditLog row with full before/after rule snapshots so an
 *     auditor can diff what changed
 *   - ApiResponse envelope for the route layer to return verbatim
 *
 * Why a separate service instead of extending ComplianceConfigService
 * directly: that service is in the hot path for every ILR / RARPA
 * lookup. Keeping it free of validation noise, audit-log dependencies,
 * and ApiResponse plumbing means it stays cheap to read.
 */

import { Types } from "mongoose";
import ApiError from "../errors/apiError";
import ApiResponse from "../errors/apiResponse";
import ComplianceConfig, {
  ComplianceDomain,
  IComplianceConfig,
} from "../models/ComplianceConfig";
import ComplianceConfigService from "./ComplianceConfigService";
import { writeAuditLog } from "./auditLog.service";
import { Request } from "express";

// ─────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────

const VALID_DOMAINS: ReadonlyArray<ComplianceDomain> = [
  "ilr",
  "rarpa",
  "asf-routing",
];

/**
 * Cheap structural check on the academic year. The brief uses
 * YYYY/YY (e.g. "2025/26"); we accept the literal that
 * ComplianceConfigService.currentAcademicYear() emits.
 */
const ACADEMIC_YEAR_RE = /^\d{4}\/\d{2}$/;

const assertDomain = (raw: string): ComplianceDomain => {
  if (!VALID_DOMAINS.includes(raw as ComplianceDomain)) {
    throw new ApiError(
      400,
      `domain must be one of ${VALID_DOMAINS.join(", ")}`,
    );
  }
  return raw as ComplianceDomain;
};

const assertAcademicYear = (raw: string): string => {
  if (!ACADEMIC_YEAR_RE.test(raw)) {
    throw new ApiError(400, "academic_year must be YYYY/YY (e.g. 2025/26)");
  }
  return raw;
};

// ─────────────────────────────────────────────────────────────────────
// GET /api/admin/compliance-config — list all versions
// ─────────────────────────────────────────────────────────────────────

export interface ConfigSummary {
  _id: string;
  domain: ComplianceDomain;
  academic_year: string;
  version: number;
  active: boolean;
  updated_at: string;
  updated_by: string | null;
  changelog: string;
}

export interface ListConfigsResponse {
  configs: ConfigSummary[];
}

/**
 * Returns every ComplianceConfig row across every domain + academic
 * year + version. Sorted by domain → academic_year → version desc
 * so the freshest version of each year-domain is at the top of its
 * group. Rules payload is INCLUDED so the editor can land directly
 * on a chosen version without a second round-trip.
 *
 * Result shape gives the UI everything it needs to render version
 * lists without further queries.
 */
export const listAllConfigsService = async (): Promise<ApiResponse> => {
  // Sort: domain asc, academic_year desc (newest year first),
  // version desc (newest version first within a year).
  const rows = await ComplianceConfig.find({})
    .sort({ domain: 1, academic_year: -1, version: -1 })
    .lean<IComplianceConfig[]>();

  const configs = rows.map((r) => ({
    _id: (r._id as Types.ObjectId).toString(),
    domain: r.domain,
    academic_year: r.academic_year,
    version: r.version,
    active: r.active,
    rules: r.rules, // include rules so the editor can show prior versions
    updated_at: r.updated_at.toISOString(),
    updated_by: r.updated_by ? r.updated_by.toString() : null,
    changelog: r.changelog ?? "",
  }));

  return new ApiResponse(200, "Compliance configs retrieved", { configs });
};

// ─────────────────────────────────────────────────────────────────────
// GET /api/admin/compliance-config/:domain/:academicYear/active
// ─────────────────────────────────────────────────────────────────────

export const getActiveConfigService = async (
  domainRaw: string,
  academicYearRaw: string,
): Promise<ApiResponse> => {
  const domain = assertDomain(domainRaw);
  const academic_year = assertAcademicYear(academicYearRaw);

  // Read from the in-memory cache so this endpoint serves the SAME
  // bytes that the ILR / RARPA pipelines are using right now — the
  // editor reads what the engine reads. A DB read would expose the
  // post-write but pre-cache-reload race; the cache is the authority.
  const doc = ComplianceConfigService.getConfig(domain, academic_year);

  if (!doc) {
    throw new ApiError(
      404,
      `No active compliance config for ${domain} / ${academic_year}`,
    );
  }

  return new ApiResponse(200, "Active compliance config", {
    _id: (doc._id as Types.ObjectId).toString(),
    domain: doc.domain,
    academic_year: doc.academic_year,
    version: doc.version,
    active: doc.active,
    rules: doc.rules,
    updated_at: doc.updated_at.toISOString(),
    updated_by: doc.updated_by ? doc.updated_by.toString() : null,
    changelog: doc.changelog ?? "",
  });
};

// ─────────────────────────────────────────────────────────────────────
// POST /api/admin/compliance-config — activate a new version
// ─────────────────────────────────────────────────────────────────────

export interface ActivateConfigInput {
  domain: string;
  academic_year: string;
  rules: unknown;
  changelog: string;
  /** Authenticated admin id — used for AuditLog and ComplianceConfig.updated_by. */
  caller_id: string;
  /** Optional request — used by writeAuditLog to pick up impersonation context. */
  req?: Request;
}

export const activateConfigService = async (
  input: ActivateConfigInput,
): Promise<ApiResponse> => {
  // ── 1. Shape validation ────────────────────────────────────────
  const domain = assertDomain(input.domain);
  const academic_year = assertAcademicYear(input.academic_year);
  if (!input.caller_id || !Types.ObjectId.isValid(input.caller_id)) {
    throw new ApiError(400, "Authenticated caller id required");
  }
  if (input.rules === undefined || input.rules === null) {
    throw new ApiError(400, "rules payload is required");
  }
  if (typeof input.rules !== "object") {
    throw new ApiError(400, "rules must be a JSON object");
  }
  if (
    typeof input.changelog !== "string" ||
    input.changelog.trim().length < 1
  ) {
    throw new ApiError(
      400,
      "changelog is required — explain WHY this version is being activated",
    );
  }
  if (input.changelog.length > 4000) {
    throw new ApiError(400, "changelog must be 4000 characters or fewer");
  }

  // ── 2. Capture the OLD active version for the audit row ───────
  // Done BEFORE the update call so the snapshot is the genuine prior
  // state, not the deactivated-but-not-yet-rotated state that the
  // service would write.
  const prior = ComplianceConfigService.getConfig(domain, academic_year);
  const prior_snapshot = prior
    ? {
        version: prior.version,
        active: prior.active,
        updated_at: prior.updated_at.toISOString(),
        rules: prior.rules,
      }
    : null;

  // ── 3. Run the deactivate-old / create-new / reload pipeline ──
  // ComplianceConfigService.update does the atomic cache swap. After
  // this resolves, getConfig() returns the new version everywhere
  // (in this Node process; multi-process invalidation is a known
  // limitation — see ComplianceConfigService file header).
  const created = await ComplianceConfigService.update(
    domain,
    academic_year,
    input.rules,
    input.changelog,
    input.caller_id,
  );

  // ── 4. AuditLog row — before/after snapshots + changelog ──────
  // `learner_id: null` and `org_id: null` — compliance-config changes
  // are platform-wide. The audit row's `reason` quotes the changelog
  // verbatim so the org-admin audit-log UI surfaces it without
  // needing to join on the ComplianceConfig collection.
  await writeAuditLog(
    {
      actor_type: "amber_admin",
      actor_id: input.caller_id,
      org_id: null,
      learner_id: null,
      action: "compliance_config_activated",
      before_state: prior_snapshot,
      after_state: {
        version: created.version,
        active: created.active,
        updated_at: created.updated_at.toISOString(),
        rules: created.rules,
      },
      reason: `Compliance config activated — ${domain} / ${academic_year} v${created.version}. ${input.changelog.trim()}`,
      compliance_config_version: created.version,
    },
    { req: input.req },
  );

  return new ApiResponse(200, "Compliance config activated", {
    _id: (created._id as Types.ObjectId).toString(),
    domain: created.domain,
    academic_year: created.academic_year,
    version: created.version,
    active: created.active,
    updated_at: created.updated_at.toISOString(),
    changelog: created.changelog,
    // The cache reload is INSIDE update(). Surface it explicitly so
    // the UI can show "Cache reloaded — every future export uses
    // this version".
    cache_reloaded: true,
  });
};
