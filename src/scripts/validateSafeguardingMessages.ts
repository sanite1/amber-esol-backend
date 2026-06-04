/* eslint-disable no-console */
/**
 * Safeguarding-messages validator — brief Function 10 To-Do 1.
 *
 * Runs as `npm run validate:safeguarding-messages`. Exits 0 on a clean
 * file, non-zero on any structural problem. CI gates the safeguarding
 * pre-cache path on this check so an empty / mistranslated message
 * can never reach a learner in distress.
 *
 * Checks (all run, all errors collected):
 *
 *   1. JSON parses                                  (else FATAL — abort)
 *   2. Top-level is an object
 *   3. All 6 categories present:
 *        self_harm, domestic_abuse, radicalisation,
 *        child_concern, exploitation, mental_health_crisis
 *   4. Each category has all 5 language keys:
 *        en, ar, so, fa, zh
 *   5. Each message is a non-empty string
 *   6. The English message references the expected signposting
 *      (number or phrase) for its category — heuristic; warns rather
 *      than errors. Catches the worst case of "Joey edited the
 *      English but pasted the wrong category's number".
 *
 * Warnings (don't fail the run):
 *   - TODO / placeholder markers in any value
 *   - English message under 80 chars (likely a stub)
 *   - Non-English message is identical to the English (likely a
 *     paste error during translation)
 */

import { readFileSync } from "fs";
import { resolve } from "path";

const FILE_PATH = resolve(__dirname, "../data/safeguarding-messages.json");

const CATEGORIES = [
  "self_harm",
  "domestic_abuse",
  "radicalisation",
  "child_concern",
  "exploitation",
  "mental_health_crisis",
] as const;

const LANGUAGES = ["en", "ar", "so", "fa", "zh"] as const;

/**
 * Per-category signposting hints — Function 10 To-Do 1 spec.
 * The English message MUST mention at least one of these strings (or
 * a hand-confirmed equivalent). Localised messages aren't checked for
 * exact phone numbers because the translator may localise the format
 * (e.g. spaces vs hyphens).
 */
const EXPECTED_SIGNPOSTS: Record<(typeof CATEGORIES)[number], string[]> = {
  self_harm:            ["Samaritans", "116 123", "SHOUT", "85258"],
  domestic_abuse:       ["National Domestic Abuse Helpline", "0808 2000 247"],
  radicalisation:       ["someone", "in touch", "note"], // brief: NO direct signposting
  child_concern:        ["NSPCC", "0808 800 5000"],
  exploitation:         ["Modern Slavery Helpline", "08000 121 700"],
  mental_health_crisis: ["NHS 111", "option 2", "SHOUT", "85258"],
};

interface Issue {
  scope: string;
  severity: "error" | "warning";
  message: string;
}

const isNonEmptyString = (v: unknown): v is string =>
  typeof v === "string" && v.trim().length > 0;

const containsTodo = (v: unknown): boolean =>
  typeof v === "string" && /\bTODO\b|REPLACE\b/i.test(v);

// ─────────────────────────────────────────────────────────────────────
// Validator
// ─────────────────────────────────────────────────────────────────────

const loadFile = (): unknown => {
  let raw: string;
  try {
    raw = readFileSync(FILE_PATH, "utf8");
  } catch (err) {
    console.error(`FATAL: cannot read ${FILE_PATH}`);
    console.error(err);
    process.exit(2);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error(`FATAL: ${FILE_PATH} is not valid JSON`);
    console.error(err);
    process.exit(2);
  }
};

const validate = (data: unknown): Issue[] => {
  const issues: Issue[] = [];

  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return [{ scope: "root", severity: "error", message: "must be a JSON object" }];
  }
  const root = data as Record<string, unknown>;

  // 3. All 6 categories present
  for (const category of CATEGORIES) {
    if (!(category in root)) {
      issues.push({
        scope: category,
        severity: "error",
        message: "category missing",
      });
      continue;
    }
    const block = root[category];
    if (!block || typeof block !== "object" || Array.isArray(block)) {
      issues.push({
        scope: category,
        severity: "error",
        message: "must be an object keyed by language",
      });
      continue;
    }
    const langBlock = block as Record<string, unknown>;

    // 4 + 5. Each language present and non-empty
    for (const lang of LANGUAGES) {
      const value = langBlock[lang];
      const path = `${category}.${lang}`;
      if (!(lang in langBlock)) {
        issues.push({
          scope: path,
          severity: "error",
          message: "language key missing",
        });
        continue;
      }
      if (!isNonEmptyString(value)) {
        issues.push({
          scope: path,
          severity: "error",
          message: "must be a non-empty string",
        });
        continue;
      }

      // TODO placeholder warning
      if (containsTodo(value)) {
        issues.push({
          scope: path,
          severity: "warning",
          message: "contains TODO/REPLACE marker — placeholder content",
        });
      }

      // 6. English signposting check
      if (lang === "en") {
        const expected = EXPECTED_SIGNPOSTS[category];
        const lower = (value as string).toLowerCase();
        const found = expected.some((sig) => lower.includes(sig.toLowerCase()));
        if (!found) {
          issues.push({
            scope: path,
            severity: "warning",
            message: `English message does not mention any of: ${expected.join(" / ")} — verify the signposting is intentional`,
          });
        }
        // Length sanity — a 30-char message is almost certainly a stub
        if ((value as string).length < 80) {
          issues.push({
            scope: path,
            severity: "warning",
            message: `English message is short (${(value as string).length} chars) — likely a stub`,
          });
        }
      }
    }

    // Translation-paste warning: non-English identical to English
    const en = langBlock.en;
    if (isNonEmptyString(en)) {
      for (const lang of LANGUAGES) {
        if (lang === "en") continue;
        const v = langBlock[lang];
        if (isNonEmptyString(v) && v === en) {
          issues.push({
            scope: `${category}.${lang}`,
            severity: "warning",
            message: "identical to the English message — likely a translation paste error",
          });
        }
      }
    }
  }

  // Extra top-level keys → warning (not error — Joey may add metadata)
  for (const key of Object.keys(root)) {
    if (!(CATEGORIES as readonly string[]).includes(key)) {
      issues.push({
        scope: key,
        severity: "warning",
        message: "unexpected top-level key (not one of the six categories)",
      });
    }
  }

  return issues;
};

// ─────────────────────────────────────────────────────────────────────
// CLI entry point
// ─────────────────────────────────────────────────────────────────────

const formatIssue = (i: Issue) =>
  `  ${i.severity === "error" ? "✗" : "•"} [${i.scope}] ${i.message}`;

const main = () => {
  const data = loadFile();
  const issues = validate(data);
  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");

  const expectedMessageCount = CATEGORIES.length * LANGUAGES.length; // 30

  console.log(
    `Validated ${FILE_PATH.split("/").slice(-1)[0]} ` +
      `(${CATEGORIES.length} categories × ${LANGUAGES.length} languages = ` +
      `${expectedMessageCount} messages): ` +
      `${errors.length} error(s), ${warnings.length} warning(s)`
  );

  if (warnings.length > 0) {
    console.log(`\nWarnings:`);
    for (const w of warnings) console.log(formatIssue(w));
  }

  if (errors.length === 0) {
    console.log(
      warnings.length > 0
        ? "\n✓ structural check passes — warnings remain"
        : "\n✓ safeguarding messages file is valid"
    );
    process.exit(0);
  }

  console.error(`\nErrors:`);
  for (const e of errors) console.error(formatIssue(e));
  console.error(
    `\nAll 30 messages must be non-empty before the safeguarding ` +
      `pre-cache path can serve them. See docs/SAFEGUARDING_REVIEW.md ` +
      `for the review process.`
  );
  process.exit(1);
};

if (require.main === module) {
  main();
}
