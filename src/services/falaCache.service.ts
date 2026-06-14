import { redis } from "../lib/redis";
import logger from "../config/logger";

/**
 * FALACache — Redis-backed set of valid ESOL LearnAimRef codes.
 *
 * Storage scheme: one Redis Set per academic year.
 *   Key:  fala:aims:<academic_year>     e.g. "fala:aims:2025/26"
 *   Type: Set of LearnAimRef strings
 *
 * Lookup is O(1) via SISMEMBER — used inside the ILR export validator
 * to reject any LearnAimRef Joey hasn't whitelisted from FALA.
 *
 * MVP seed: a small hardcoded list of public ESOL Skills for Life codes
 * (see SEED_AIM_REFS below). Joey must confirm each against FALA at
 * https://submit-learner-data.service.gov.uk/find-a-learning-aim before
 * any real ILR claim depends on this whitelist.
 *
 * Monthly refresh: a cron at "0 8 1 * *" calls
 * POST /api/admin/cache/fala/reload which enqueues a cache-refresh job
 * that re-populates the set. Future: actual FALA API integration.
 */

const TARGET_ACADEMIC_YEAR = "2025/26";

const keyForYear = (year: string): string => `fala:aims:${year}`;

/**
 * MVP seed list — ESOL Skills for Life LearnAimRefs.
 *
 * IMPORTANT: every entry here is a placeholder pending Joey's verification
 * against FALA. The format is correct (8-character LARS code) but the codes
 * themselves should be replaced before production. Examples include both
 * accredited NOCN / Cambridge / Trinity Entry-Level qualifications.
 */
const SEED_AIM_REFS: readonly string[] = [
  // Joey to replace these with verified codes from
  // https://submit-learner-data.service.gov.uk/find-a-learning-aim
  "60139560", // placeholder — NOCN Entry Level Certificate in ESOL (example)
  "60139572", // placeholder — Trinity ESOL Skills for Life Entry 2
  "60139584", // placeholder — Cambridge ESOL Skills for Life Entry 3
  "60139596", // placeholder — Level 1 ESOL
  "60139603", // placeholder — Level 2 ESOL
] as const;

/**
 * Check whether a LearnAimRef is in the whitelist for an academic year.
 * Returns false if not whitelisted or if Redis is unreachable (fail closed).
 */
const isValidAim = async (
  ref: string,
  academicYear: string,
): Promise<boolean> => {
  if (!ref || !academicYear) return false;
  try {
    const present = await redis.sismember(keyForYear(academicYear), ref);
    return present === 1;
  } catch (err) {
    logger.error(
      { ref, academicYear, err: (err as Error).message },
      "FALACache.isValidAim failed — failing closed",
    );
    return false;
  }
};

/**
 * Reload the FALA whitelist for the given year.
 *
 * Idempotent: drops the existing set entirely then re-populates. Atomic
 * within Redis via DEL + SADD pipeline.
 */
const reload = async (
  academicYear: string = TARGET_ACADEMIC_YEAR,
  refs: readonly string[] = SEED_AIM_REFS,
): Promise<{ count: number }> => {
  const key = keyForYear(academicYear);
  const pipeline = redis.pipeline();
  pipeline.del(key);
  if (refs.length > 0) {
    pipeline.sadd(key, ...refs);
  }
  await pipeline.exec();
  logger.info(
    { academicYear, count: refs.length, key },
    "FALACache reload complete",
  );
  return { count: refs.length };
};

/**
 * Returns true if the current year's whitelist has at least one entry.
 * Used at boot to decide whether to enqueue the startup seed job.
 */
const isPopulated = async (
  academicYear: string = TARGET_ACADEMIC_YEAR,
): Promise<boolean> => {
  try {
    const count = await redis.scard(keyForYear(academicYear));
    return count > 0;
  } catch {
    return false;
  }
};

const FALACache = {
  isValidAim,
  reload,
  isPopulated,
  TARGET_ACADEMIC_YEAR,
  __seedForTests: SEED_AIM_REFS,
};

export default FALACache;
