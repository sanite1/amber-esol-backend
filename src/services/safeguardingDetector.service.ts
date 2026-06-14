import SafeguardingKeyword, {
  SafeguardingCategory,
  SafeguardingSeverity,
} from "../models/SafeguardingKeyword";
import logger from "../config/logger";

/**
 * SafeguardingDetector — pre-Gemini keyword/regex screen.
 *
 * Runs against EVERY learner message before any Gemini call. Defence in
 * depth: Gemini's own safeguarding_flag is a secondary confirmation, not
 * the primary trigger. The detector here is deterministic, auditable, and
 * sub-millisecond per scan after loadAll().
 *
 * Pattern format:
 *   - Plain text → case-insensitive substring match
 *   - Source delimited by /.../[flags] → compiled as RegExp
 *     e.g. "/\\b(?:cut|hurt)\\s+myself\\b/i"
 *
 * Tie-breaking: when multiple patterns could match, severity wins
 * (high > medium > low). First matching pattern within the same severity
 * tier wins — there's no concept of a "least severe interpretation".
 */

interface CompiledKeyword {
  category: SafeguardingCategory;
  severity: SafeguardingSeverity;
  original: string;
  matcher: { kind: "literal"; needle: string } | { kind: "regex"; rx: RegExp };
}

const SEVERITY_RANK: Record<SafeguardingSeverity, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

// language → ordered array of patterns (sorted by severity)
let cache: Map<string, CompiledKeyword[]> = new Map();

/**
 * Detect /.../[flags] form. Captures the source and flags separately.
 *
 * Pattern source must end with a closing slash followed by zero or more
 * regex flag letters (i, g, m, s, u, y).
 */
const REGEX_FORM = /^\/(.+)\/([gimsuy]*)$/;

const compile = (pattern: string): CompiledKeyword["matcher"] => {
  const m = pattern.match(REGEX_FORM);
  if (m) {
    try {
      const flags = m[2].includes("i") ? m[2] : m[2] + "i"; // always case-insensitive
      return { kind: "regex", rx: new RegExp(m[1], flags) };
    } catch (err) {
      // Fall through to literal — invalid regex shouldn't break the loader,
      // but we want it visible in logs.
      logger.warn(
        { pattern, err: (err as Error).message },
        "Invalid regex pattern in SafeguardingKeyword — falling back to literal substring",
      );
    }
  }
  return { kind: "literal", needle: pattern.toLowerCase() };
};

/**
 * Reload the in-memory cache from Mongo. Atomic pointer swap.
 *
 * Logs the per-language pattern count so a misconfigured collection
 * (e.g. zero active patterns) is obvious at boot.
 */
const loadAll = async (): Promise<void> => {
  const docs = await SafeguardingKeyword.find({ active: true }).lean();

  const next = new Map<string, CompiledKeyword[]>();
  for (const doc of docs) {
    const compiled: CompiledKeyword = {
      category: doc.category,
      severity: doc.severity,
      original: doc.pattern,
      matcher: compile(doc.pattern),
    };
    const arr = next.get(doc.language) ?? [];
    arr.push(compiled);
    next.set(doc.language, arr);
  }

  // Sort each language's patterns by severity (high first)
  for (const [, arr] of next) {
    arr.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
  }

  cache = next;

  const summary = Array.from(next.entries())
    .map(([lang, arr]) => `${lang}=${arr.length}`)
    .join(", ");
  logger.info(
    `SafeguardingDetector loaded: ${docs.length} patterns across ${next.size} languages${summary ? ` (${summary})` : ""}`,
  );
};

export interface ScanResult {
  triggered: boolean;
  category: SafeguardingCategory | null;
  matched_pattern: string | null;
}

const NO_MATCH: ScanResult = {
  triggered: false,
  category: null,
  matched_pattern: null,
};

/**
 * Synchronously scan a learner message. Returns the first match (highest
 * severity first), or NO_MATCH if nothing fired.
 *
 * If `lang` has no patterns, falls back to English — better to over-trigger
 * than miss a disclosure because we don't have L1 keywords yet.
 */
const scan = (message: string, lang: string): ScanResult => {
  if (!message || message.length === 0) return NO_MATCH;

  const haystackLower = message.toLowerCase();
  const candidates = cache.get(lang) ?? cache.get("en") ?? [];

  for (const k of candidates) {
    if (k.matcher.kind === "literal") {
      if (haystackLower.includes(k.matcher.needle)) {
        return {
          triggered: true,
          category: k.category,
          matched_pattern: k.original,
        };
      }
    } else {
      if (k.matcher.rx.test(message)) {
        return {
          triggered: true,
          category: k.category,
          matched_pattern: k.original,
        };
      }
    }
  }

  return NO_MATCH;
};

/** Test-only — wipe cache. */
const __resetCacheForTests = (): void => {
  cache = new Map();
};

const SafeguardingDetector = {
  loadAll,
  scan,
  __resetCacheForTests,
};

export default SafeguardingDetector;
