/**
 * CurriculumLevel read service — in-memory cache of the seeded
 * CurriculumLevel collection (AI Tutor Build Brief §1.1).
 *
 * Mirrors ComplianceConfigService: load the active (latest-version)
 * level docs into memory at boot, expose a synchronous getLevel() the
 * hot paths (Layer 3/5 prompt build, placement objective bank, vocab
 * retention threshold, Bridge mode controller) read each turn without
 * a Mongo round-trip. Re-seeding + a process restart picks up a new
 * curriculum version.
 */

import CurriculumLevel, {
  ICurriculumLevel,
  NqfLevel,
} from "../models/CurriculumLevel";
import logger from "../config/logger";

let cache = new Map<NqfLevel, ICurriculumLevel>();
let loadedVersion: string | null = null;

/** Normalise "Entry 1" / "e1" / "E1" → "E1"; null if unrecognised. */
export const normaliseNqfLevel = (raw: unknown): NqfLevel | null => {
  if (typeof raw !== "string") return null;
  const lc = raw.trim().toLowerCase();
  if (["e1", "e2", "e3", "l1", "l2"].includes(lc)) {
    return lc.toUpperCase() as NqfLevel;
  }
  const m = lc.match(/^(entry|level)\s*(\d)$/);
  if (m) return `${m[1] === "entry" ? "E" : "L"}${m[2]}` as NqfLevel;
  return null;
};

/**
 * Populate the cache from the latest curriculum version in Mongo.
 * Picks the highest `version` (lexicographic on the ISO date stamp)
 * so a re-seed with a newer date becomes active on restart. Safe to
 * call repeatedly — replaces the cache via atomic pointer swap.
 */
const loadAll = async (): Promise<void> => {
  const docs = await CurriculumLevel.find({}).lean<ICurriculumLevel[]>();
  if (docs.length === 0) {
    logger.warn(
      "CurriculumLevel cache empty — run `npm run seed:curriculum`. " +
        "Layer 3/5 prompt build + placement objectives will fall back.",
    );
    cache = new Map();
    loadedVersion = null;
    return;
  }
  const latest = docs.reduce(
    (acc, d) => (d.version > acc ? d.version : acc),
    docs[0].version,
  );
  const next = new Map<NqfLevel, ICurriculumLevel>();
  for (const d of docs) {
    if (d.version === latest) next.set(d.level, d);
  }
  cache = next;
  loadedVersion = latest;
  logger.info(
    { levels: next.size, version: latest },
    "CurriculumLevel cache loaded",
  );
};

/** Synchronous read. Accepts code or display form. Null if absent. */
const getLevel = (level: unknown): ICurriculumLevel | null => {
  const code = normaliseNqfLevel(level);
  if (!code) return null;
  return cache.get(code) ?? null;
};

const getActiveVersion = (): string | null => loadedVersion;

/**
 * Encounters required before a vocabulary item can be marked
 * `retained`, for the given level (F27). Reads
 * `CurriculumLevel.retentionEncounters.min` — the floor of the level's
 * spaced-reinforcement band. Returns null when the level isn't seeded,
 * so the caller keeps its own default.
 */
const getRetentionMinEncounters = (level: unknown): number | null => {
  const doc = getLevel(level);
  const min = doc?.retentionEncounters?.min;
  return typeof min === "number" && Number.isFinite(min) && min > 0
    ? min
    : null;
};

/**
 * Developmentally-late ("long-horizon") grammar forms for a level —
 * 3SG-s, articles, subject-verb inversion, etc. These are RECYCLED,
 * never marked as failed learning (F27 / Bridge Method). Empty array
 * when the level isn't seeded.
 */
const getLongHorizonForms = (level: unknown): string[] => {
  const doc = getLevel(level);
  return Array.isArray(doc?.longHorizonForms) ? doc!.longHorizonForms : [];
};

/** Case-insensitive membership test against the level's long-horizon set. */
const isLongHorizonForm = (level: unknown, form: string): boolean => {
  const f = (form ?? "").trim().toLowerCase();
  if (!f) return false;
  return getLongHorizonForms(level).some((lhf) => lhf.toLowerCase() === f);
};

const __resetForTests = (): void => {
  cache = new Map();
  loadedVersion = null;
};

const CurriculumLevelService = {
  loadAll,
  getLevel,
  getActiveVersion,
  getRetentionMinEncounters,
  getLongHorizonForms,
  isLongHorizonForm,
  normaliseNqfLevel,
  __resetForTests,
};

export default CurriculumLevelService;
