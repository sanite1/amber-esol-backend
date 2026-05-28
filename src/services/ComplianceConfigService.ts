import { Types } from "mongoose";
import ComplianceConfig, {
  ComplianceDomain,
  IComplianceConfig,
} from "../models/ComplianceConfig";
import logger from "../config/logger";

/**
 * ComplianceConfigService — in-memory cache of active compliance rules.
 *
 * Every read goes through this service. The cache is loaded once at startup
 * via loadAll() and refreshed atomically when update() lands a new version.
 *
 * Why a cache and not a per-request DB read:
 *   - ILR / RARPA rules are queried inside hot paths (session evidence,
 *     export validation, postcode routing). A round-trip to Mongo per
 *     lookup would be unacceptable.
 *   - The data is small (kilobytes per domain) and changes ~yearly.
 *   - Cache atomicity is trivial in single-threaded Node: reassigning the
 *     module-level Map pointer is an atomic operation; readers either see
 *     the old map or the new one, never a partially-built map.
 *
 * Multi-process note: each Node process holds its own cache. After update(),
 * other processes (e.g. worker pods) will keep serving stale config until
 * THEY also call loadAll(). For now we accept this lag — annual updates
 * tolerate a rolling restart. A pub/sub invalidation channel can be added
 * later if needed.
 */

type CacheKey = `${ComplianceDomain}:${string}`;

let cache: Map<CacheKey, IComplianceConfig> = new Map();

const makeKey = (domain: ComplianceDomain, academicYear: string): CacheKey =>
  `${domain}:${academicYear}`;

/**
 * Returns the current UK academic year code based on the 1 August boundary.
 *
 * Examples:
 *   31 Jul 2026 → "2025/26"
 *   01 Aug 2026 → "2026/27"
 *   14 May 2026 → "2025/26"
 */
const currentAcademicYear = (now: Date = new Date()): string => {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth(); // 0=Jan, 7=Aug
  if (month >= 7) {
    return `${year}/${String(year + 1).slice(-2)}`;
  }
  return `${year - 1}/${String(year).slice(-2)}`;
};

/**
 * Populate the cache from every active ComplianceConfig in Mongo.
 *
 * Logs the count when done. Safe to call repeatedly — completely replaces
 * the cache atomically via pointer swap.
 */
const loadAll = async (): Promise<void> => {
  const docs = await ComplianceConfig.find({ active: true }).lean<
    IComplianceConfig[]
  >();

  const next = new Map<CacheKey, IComplianceConfig>();
  for (const doc of docs) {
    next.set(makeKey(doc.domain, doc.academic_year), doc);
  }

  cache = next; // atomic pointer swap
  logger.info(`ComplianceConfig loaded: ${next.size} active configs`);
};

/**
 * Synchronous in-memory read. Returns null if the requested (domain, year)
 * has no active config — callers MUST handle null (fail closed, log, alert)
 * rather than assume rules exist.
 */
const getConfig = (
  domain: ComplianceDomain,
  academicYear: string
): IComplianceConfig | null => {
  const hit = cache.get(makeKey(domain, academicYear));
  return hit ?? null;
};

/**
 * Convenience accessor — fetch the config for the current academic year
 * (UK boundary at 1 August).
 */
const getCurrent = (domain: ComplianceDomain): IComplianceConfig | null =>
  getConfig(domain, currentAcademicYear());

/**
 * Land a new version of a config.
 *
 *   1. Find current active doc for (domain, academic_year)
 *   2. Deactivate it (saves)
 *   3. Create new doc with version = prior + 1, active: true (saves)
 *   4. Reload the cache atomically
 *
 * Returns the newly-created active document.
 *
 * Race safety: the partial-unique index on (domain, academic_year, active:
 * true) means step 3 will hard-fail at the DB if step 2 didn't actually
 * land — preferable to silently double-activating.
 */
const update = async (
  domain: ComplianceDomain,
  academicYear: string,
  rules: unknown,
  changelog: string,
  userId: Types.ObjectId | string | null
): Promise<IComplianceConfig> => {
  const existing = await ComplianceConfig.findOne({
    domain,
    academic_year: academicYear,
    active: true,
  });

  const nextVersion = existing ? existing.version + 1 : 1;

  if (existing) {
    existing.active = false;
    await existing.save();
  }

  const created = await ComplianceConfig.create({
    domain,
    academic_year: academicYear,
    version: nextVersion,
    active: true,
    rules,
    updated_by: userId ? new Types.ObjectId(String(userId)) : null,
    updated_at: new Date(),
    changelog,
  });

  await loadAll();
  return created;
};

/**
 * Test-only helper. Wipes the in-memory cache without touching Mongo. Use
 * in unit tests to force a known empty state before priming via fixtures.
 */
const __resetCacheForTests = (): void => {
  cache = new Map();
};

const ComplianceConfigService = {
  loadAll,
  getConfig,
  getCurrent,
  update,
  currentAcademicYear,
  __resetCacheForTests,
};

export default ComplianceConfigService;
