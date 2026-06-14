import path from "path";
import { readFileSync } from "fs";
import { redis } from "../lib/redis";
import logger from "../config/logger";

/**
 * PostcodeRouter — Redis-backed UK postcode → ASF funding authority lookup.
 *
 * Storage scheme:
 *   Hot lookup:     postcode:<NORMALISED>   →  JSON { sof, ldm, mca, authority_name }
 *   Load marker:    postcode:dataset_loaded →  "2025/26" (the academic year currently loaded)
 *
 * Normalisation: uppercase + strip whitespace. "ec1a 1bb" → "EC1A1BB".
 *
 * Load strategy (the brief's request):
 *   - At startup we check the marker key.
 *   - If absent or stale, enqueue a cache-refresh job that calls
 *     loadDatasetFromSource() inside a worker.
 *   - The admin route POST /api/admin/cache/postcode/reload enqueues the
 *     same job manually (used every August when the new postcode file
 *     ships from gov.uk).
 *
 * Data source — IMPORTANT:
 *   Production must download the DfE ASF master file from
 *   https://www.gov.uk/government/publications/adult-skills-fund-asf-postcode-files
 *   That file is ~83.6 MB / ~3M rows and will not fit Upstash free tier.
 *
 *   For dev we ship a 10-postcode sample CSV at src/data/postcode-sample.csv
 *   covering one postcode per major MCA. `loadDatasetFromSource()` reads
 *   from `POSTCODE_DATASET_PATH` env var (defaults to the bundled sample)
 *   OR from `POSTCODE_DATASET_URL` if set (production).
 *
 *   The TODO marker below is the splice point for the real downloader.
 */

const TARGET_ACADEMIC_YEAR = "2025/26";
const MARKER_KEY = "postcode:dataset_loaded";

export interface PostcodeRoutingEntry {
  sof: string;
  ldm: string;
  mca: string;
  authority_name: string;
}

/** Uppercase + strip all whitespace. Used for both key construction and input. */
const normalise = (postcode: string): string =>
  postcode.toUpperCase().replace(/\s+/g, "");

/**
 * Look up a postcode in Redis. Returns null if not present.
 * Target latency: < 10 ms for warm Redis (cold connections may be slower).
 */
const lookup = async (
  postcode: string,
): Promise<PostcodeRoutingEntry | null> => {
  if (!postcode) return null;
  const raw = await redis.get(`postcode:${normalise(postcode)}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PostcodeRoutingEntry;
  } catch (err) {
    logger.error(
      { postcode, raw, err: (err as Error).message },
      "Malformed postcode entry in Redis",
    );
    return null;
  }
};

/**
 * Parse a CSV in the format used by both the DfE master file and our local
 * sample: header row `postcode,sof,ldm,mca,authority_name` followed by rows.
 *
 * Skips blank lines. Tolerant of trailing commas and missing trailing fields
 * (treats them as empty strings). Quote handling is minimal — fine for the
 * gov.uk file which is unquoted.
 */
const parseCsv = (
  csv: string,
): Array<PostcodeRoutingEntry & { postcode: string }> => {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];

  // Validate header
  const headerCells = lines[0].split(",").map((s) => s.trim().toLowerCase());
  const required = ["postcode", "sof", "ldm", "mca", "authority_name"];
  for (const col of required) {
    if (!headerCells.includes(col)) {
      throw new Error(
        `Postcode CSV is missing required column "${col}". Header was: ${headerCells.join(", ")}`,
      );
    }
  }

  const idx = (name: string) => headerCells.indexOf(name);
  const out: Array<PostcodeRoutingEntry & { postcode: string }> = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(",");
    out.push({
      postcode: (cells[idx("postcode")] ?? "").trim(),
      sof: (cells[idx("sof")] ?? "").trim(),
      ldm: (cells[idx("ldm")] ?? "").trim(),
      mca: (cells[idx("mca")] ?? "").trim(),
      authority_name: (cells[idx("authority_name")] ?? "").trim(),
    });
  }
  return out;
};

/**
 * Bulk-write parsed rows to Redis using a pipeline. After every row is
 * written, the marker key gets set so partial loads don't claim success.
 */
const writeToRedis = async (
  rows: Array<PostcodeRoutingEntry & { postcode: string }>,
  academicYear: string,
): Promise<{ written: number }> => {
  const pipeline = redis.pipeline();
  for (const row of rows) {
    const key = `postcode:${normalise(row.postcode)}`;
    const value = JSON.stringify({
      sof: row.sof,
      ldm: row.ldm,
      mca: row.mca,
      authority_name: row.authority_name,
    });
    pipeline.set(key, value);
  }
  pipeline.set(MARKER_KEY, academicYear);
  await pipeline.exec();
  return { written: rows.length };
};

/**
 * Read the dataset from disk (or download from URL when implemented) and
 * write to Redis. Called by the cache-refresh worker after the admin route
 * or startup check enqueues a job.
 *
 * Path resolution:
 *   1. POSTCODE_DATASET_URL set → TODO: download from URL (production)
 *   2. POSTCODE_DATASET_PATH set → read from that local file
 *   3. Neither set → use bundled sample at src/data/postcode-sample.csv
 */
const loadDatasetFromSource = async (
  academicYear: string = TARGET_ACADEMIC_YEAR,
): Promise<{ written: number; source: string }> => {
  const url = process.env.POSTCODE_DATASET_URL;
  const localPath = process.env.POSTCODE_DATASET_PATH;

  let source: string;
  let csv: string;

  if (url) {
    // TODO(production): implement gov.uk download.
    //   The DfE master file is ~83.6 MB. Use streaming fetch + parser to
    //   avoid loading into memory. Confirm the URL still points to a CSV
    //   (gov.uk has historically swapped formats) and add an ETag check
    //   so re-running doesn't re-download unchanged data.
    throw new Error(
      "POSTCODE_DATASET_URL download not yet implemented. Set POSTCODE_DATASET_PATH to a local CSV instead, or unset both to use the bundled sample.",
    );
  } else if (localPath) {
    source = `file:${localPath}`;
    csv = readFileSync(localPath, "utf-8");
  } else {
    source = "bundled-sample";
    csv = readFileSync(
      path.join(__dirname, "../data/postcode-sample.csv"),
      "utf-8",
    );
  }

  const rows = parseCsv(csv);
  if (rows.length === 0) {
    throw new Error(`Postcode dataset parsed to zero rows (source: ${source})`);
  }

  const result = await writeToRedis(rows, academicYear);
  logger.info(
    { source, written: result.written, academicYear },
    "Postcode dataset loaded to Redis",
  );
  return { ...result, source };
};

/**
 * Returns true if the marker key matches the target academic year.
 * Called from boot to decide whether to enqueue the startup load job.
 */
const isLoaded = async (
  academicYear: string = TARGET_ACADEMIC_YEAR,
): Promise<boolean> => {
  const v = await redis.get(MARKER_KEY);
  return v === academicYear;
};

const PostcodeRouter = {
  lookup,
  loadDatasetFromSource,
  isLoaded,
  TARGET_ACADEMIC_YEAR,
  MARKER_KEY,
  __normaliseForTests: normalise,
};

export default PostcodeRouter;
