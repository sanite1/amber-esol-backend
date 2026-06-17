/* eslint-disable no-console */
/**
 * Scenario file validator — brief Function 7 To-Do 2.
 *
 * Runs as `npm run validate:scenarios`. Exits 0 on a clean set, non-zero
 * on any structural problem. CI gates merges on this exit code so a
 * malformed scenario can never reach production.
 *
 * Walks `src/data/scenarios/*.json`, parses each, and applies the
 * authoring rules declared in scenario.interface.ts:
 *
 *   1. JSON parses
 *   2. scenario_id is non-empty and unique across files
 *   3. nqf_level_range.min ≤ max on the e1→l2 scale
 *   4. skill_codes non-empty + every value a valid IlrSkillCode
 *   5. stage3_objective_domains non-empty + valid set members
 *   6. vocabulary_set length ≥ MIN_VOCAB (20)
 *   7. every vocabulary item has all 4 non-English translations populated
 *      (en is the source — lives in definition_en)
 *   8. title has all 5 MVP language entries, all non-empty
 *   9. cultural_notes has all 5 MVP language entries, all non-empty
 *  10. pass_threshold ∈ [PASS_MIN, PASS_MAX] (0.6 to 0.9)
 *  11. grammar_targets non-empty
 *  12. roleplay_prompt_en non-empty
 *
 * Warnings (printed but don't fail the run):
 *   - any TODO_ prefix in a value — placeholder content still in the file
 *   - missing `authoring` block — scenario hasn't been signed off
 *
 * Design: same shape as src/utils/validatePlacementBank.ts. Pure fs +
 * JSON parse, no runtime deps. Errors prefixed with the scenario id +
 * field path so they're greppable in CI logs.
 */

import { readFileSync, readdirSync } from "fs";
import { resolve } from "path";

import {
  IScenarioFile,
  IlrSkillCode,
  Stage3ObjectiveAnchor,
  ScenarioLanguage,
} from "../interfaces/scenario.interface";
import { EsolLevel } from "../interfaces/placementQuestion.interface";

// ─────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────

const SCENARIOS_DIR = resolve(__dirname, "../data/scenarios");

const MIN_VOCAB = 20;
const PASS_MIN = 0.6;
const PASS_MAX = 0.9;

const LEVELS_ASC: EsolLevel[] = ["e1", "e2", "e3", "l1", "l2"];

const VALID_ILR_CODES: ReadonlySet<IlrSkillCode> = new Set<IlrSkillCode>([
  "Rt",
  "Rs",
  "Rw",
  "Wt",
  "Ws",
  "Ww",
  "Lr",
  "Sc",
  "Sd",
]);

// Brief Function 8 To-Do 3: scenario.stage3_objective_domains stores
// the four ILR ANCHOR codes (Sc/Lr/Rt/Wt), not domain names. The four
// anchors map to the four ForSkills domains via DOMAIN_TO_ANCHOR in
// esolSkills.ts. Sub-codes (Sd/Rs/Rw/Ws/Ww) are NOT valid here.
const VALID_STAGE3_DOMAINS: ReadonlySet<Stage3ObjectiveAnchor> =
  new Set<Stage3ObjectiveAnchor>(["Sc", "Lr", "Rt", "Wt"]);

const NON_EN_LANGS: ScenarioLanguage[] = ["ar", "so", "fa", "zh"];
const ALL_LANGS: ScenarioLanguage[] = ["en", ...NON_EN_LANGS];

// ─────────────────────────────────────────────────────────────────────
// Validator
// ─────────────────────────────────────────────────────────────────────

interface Issue {
  scope: string; // "<scenario_id>.<field>" or "set"
  severity: "error" | "warning";
  message: string;
}

const isNonEmptyString = (v: unknown): v is string =>
  typeof v === "string" && v.trim().length > 0;

const containsTodo = (v: unknown): boolean =>
  typeof v === "string" && /\bTODO\b|REPLACE\b/i.test(v);

const loadScenarioFiles = (): { id: string; path: string; raw: string }[] => {
  let entries: string[];
  try {
    entries = readdirSync(SCENARIOS_DIR);
  } catch (err) {
    console.error(`FATAL: cannot read ${SCENARIOS_DIR}`);
    console.error(err);
    process.exit(2);
  }
  const files = entries.filter((e) => e.toLowerCase().endsWith(".json"));
  if (files.length === 0) {
    console.error(`FATAL: no .json files in ${SCENARIOS_DIR}`);
    process.exit(2);
  }
  return files.map((f) => ({
    id: f.replace(/\.json$/i, ""),
    path: resolve(SCENARIOS_DIR, f),
    raw: readFileSync(resolve(SCENARIOS_DIR, f), "utf8"),
  }));
};

const parseScenario = (
  fileName: string,
  raw: string,
): { ok: true; data: IScenarioFile } | { ok: false; error: Issue } => {
  try {
    return { ok: true, data: JSON.parse(raw) as IScenarioFile };
  } catch (err) {
    return {
      ok: false,
      error: {
        scope: fileName,
        severity: "error",
        message: `JSON parse failed: ${(err as Error).message}`,
      },
    };
  }
};

const validateRange = (
  range: { min: EsolLevel; max: EsolLevel } | undefined,
  scope: string,
): Issue[] => {
  if (!range || !range.min || !range.max) {
    return [
      {
        scope: `${scope}.nqf_level_range`,
        severity: "error",
        message: "missing min/max",
      },
    ];
  }
  const minIdx = LEVELS_ASC.indexOf(range.min);
  const maxIdx = LEVELS_ASC.indexOf(range.max);
  if (minIdx === -1) {
    return [
      {
        scope: `${scope}.nqf_level_range.min`,
        severity: "error",
        message: `"${range.min}" is not a valid EsolLevel`,
      },
    ];
  }
  if (maxIdx === -1) {
    return [
      {
        scope: `${scope}.nqf_level_range.max`,
        severity: "error",
        message: `"${range.max}" is not a valid EsolLevel`,
      },
    ];
  }
  if (minIdx > maxIdx) {
    return [
      {
        scope: `${scope}.nqf_level_range`,
        severity: "error",
        message: `min "${range.min}" > max "${range.max}"`,
      },
    ];
  }
  return [];
};

const validateMultilingualText = (
  obj: Record<string, unknown> | undefined,
  scope: string,
): Issue[] => {
  const issues: Issue[] = [];
  if (!obj) {
    return [{ scope, severity: "error", message: "missing" }];
  }
  for (const lang of ALL_LANGS) {
    const value = obj[lang];
    if (!isNonEmptyString(value)) {
      issues.push({
        scope: `${scope}.${lang}`,
        severity: "error",
        message: `must be a non-empty string`,
      });
    } else if (containsTodo(value)) {
      issues.push({
        scope: `${scope}.${lang}`,
        severity: "warning",
        message: `contains TODO/REPLACE marker — placeholder content`,
      });
    }
  }
  return issues;
};

const validateVocabulary = (vocab: unknown, scope: string): Issue[] => {
  const issues: Issue[] = [];
  if (!Array.isArray(vocab)) {
    return [{ scope, severity: "error", message: "must be an array" }];
  }
  if (vocab.length < MIN_VOCAB) {
    issues.push({
      scope,
      severity: "error",
      message: `has ${vocab.length} item(s); need ≥ ${MIN_VOCAB}`,
    });
  }
  vocab.forEach((item, idx) => {
    const v = item as Partial<{
      word: string;
      definition_en: string;
      translations: Record<string, string>;
      example_sentence: string;
      reinforcement_weight: number;
    }>;
    const itemScope = `${scope}[${idx}]${v?.word ? ` "${v.word}"` : ""}`;
    if (!isNonEmptyString(v?.word)) {
      issues.push({
        scope: `${itemScope}.word`,
        severity: "error",
        message: "must be a non-empty string",
      });
    } else if (containsTodo(v.word)) {
      issues.push({
        scope: `${itemScope}.word`,
        severity: "warning",
        message: "contains TODO/REPLACE — placeholder vocabulary item",
      });
    }
    if (!isNonEmptyString(v?.definition_en)) {
      issues.push({
        scope: `${itemScope}.definition_en`,
        severity: "error",
        message: "must be a non-empty string",
      });
    } else if (containsTodo(v.definition_en)) {
      issues.push({
        scope: `${itemScope}.definition_en`,
        severity: "warning",
        message: "contains TODO/REPLACE marker",
      });
    }
    if (!isNonEmptyString(v?.example_sentence)) {
      issues.push({
        scope: `${itemScope}.example_sentence`,
        severity: "error",
        message: "must be a non-empty string",
      });
    }
    if (
      typeof v?.reinforcement_weight !== "number" ||
      !Number.isFinite(v.reinforcement_weight) ||
      v.reinforcement_weight < 0 ||
      v.reinforcement_weight > 1
    ) {
      issues.push({
        scope: `${itemScope}.reinforcement_weight`,
        severity: "error",
        message: `must be a number in [0, 1], got ${v?.reinforcement_weight}`,
      });
    }
    if (!v?.translations) {
      issues.push({
        scope: `${itemScope}.translations`,
        severity: "error",
        message: "missing — must contain ar/so/fa/zh",
      });
    } else {
      for (const lang of NON_EN_LANGS) {
        const t = v.translations[lang];
        if (!isNonEmptyString(t)) {
          issues.push({
            scope: `${itemScope}.translations.${lang}`,
            severity: "error",
            message: "must be a non-empty string",
          });
        }
      }
    }
  });
  return issues;
};

const validateScenario = (id: string, s: IScenarioFile): Issue[] => {
  const issues: Issue[] = [];
  const scope = id;

  // scenario_id
  if (!isNonEmptyString(s.scenario_id)) {
    issues.push({
      scope: `${scope}.scenario_id`,
      severity: "error",
      message: "must be non-empty",
    });
  } else if (s.scenario_id !== id) {
    issues.push({
      scope: `${scope}.scenario_id`,
      severity: "error",
      message: `does not match file name — file says "${id}", JSON says "${s.scenario_id}"`,
    });
  }

  issues.push(...validateRange(s.nqf_level_range, scope));

  // skill_codes
  if (!Array.isArray(s.skill_codes) || s.skill_codes.length === 0) {
    issues.push({
      scope: `${scope}.skill_codes`,
      severity: "error",
      message: "must be a non-empty array",
    });
  } else {
    for (const code of s.skill_codes) {
      if (!VALID_ILR_CODES.has(code as IlrSkillCode)) {
        issues.push({
          scope: `${scope}.skill_codes`,
          severity: "error",
          message: `"${code}" is not a valid IlrSkillCode`,
        });
      }
    }
  }

  // stage3_objective_domains
  if (
    !Array.isArray(s.stage3_objective_domains) ||
    s.stage3_objective_domains.length === 0
  ) {
    issues.push({
      scope: `${scope}.stage3_objective_domains`,
      severity: "error",
      message: "must be a non-empty array",
    });
  } else {
    for (const d of s.stage3_objective_domains) {
      if (!VALID_STAGE3_DOMAINS.has(d as Stage3ObjectiveAnchor)) {
        issues.push({
          scope: `${scope}.stage3_objective_domains`,
          severity: "error",
          message: `"${d}" is not a valid Stage 3 anchor — must be one of Sc, Lr, Rt, Wt`,
        });
      }
    }
  }

  // title — multilingual
  issues.push(...validateMultilingualText(s.title as any, `${scope}.title`));

  // cultural_notes_* — flat fields, one per language
  for (const lang of ALL_LANGS) {
    const key = `cultural_notes_${lang}` as keyof IScenarioFile;
    const value = s[key];
    if (!isNonEmptyString(value)) {
      issues.push({
        scope: `${scope}.${key}`,
        severity: "error",
        message: "must be a non-empty string",
      });
    } else if (containsTodo(value as string)) {
      issues.push({
        scope: `${scope}.${key}`,
        severity: "warning",
        message: "contains TODO/REPLACE marker — placeholder content",
      });
    }
  }

  // grammar_targets
  if (!Array.isArray(s.grammar_targets) || s.grammar_targets.length === 0) {
    issues.push({
      scope: `${scope}.grammar_targets`,
      severity: "error",
      message: "must be a non-empty array",
    });
  } else if (s.grammar_targets.some((g) => containsTodo(g))) {
    issues.push({
      scope: `${scope}.grammar_targets`,
      severity: "warning",
      message: "contains TODO marker — placeholder content",
    });
  }

  // roleplay_prompt_en
  if (!isNonEmptyString(s.roleplay_prompt_en)) {
    issues.push({
      scope: `${scope}.roleplay_prompt_en`,
      severity: "error",
      message: "must be non-empty",
    });
  } else if (containsTodo(s.roleplay_prompt_en)) {
    issues.push({
      scope: `${scope}.roleplay_prompt_en`,
      severity: "warning",
      message: "contains TODO/REPLACE marker",
    });
  }

  // micro_stages (F25) — optional, but when present must be exactly
  // four non-empty labels (one per learner-facing progress dot). A
  // scenario with none falls back to the generic four-beat arc.
  if (s.micro_stages !== undefined) {
    if (!Array.isArray(s.micro_stages) || s.micro_stages.length !== 4) {
      issues.push({
        scope: `${scope}.micro_stages`,
        severity: "error",
        message: `when present, must be an array of exactly 4 labels, got ${
          Array.isArray(s.micro_stages)
            ? s.micro_stages.length
            : typeof s.micro_stages
        }`,
      });
    } else if (s.micro_stages.some((m) => !isNonEmptyString(m))) {
      issues.push({
        scope: `${scope}.micro_stages`,
        severity: "error",
        message: "every micro-stage label must be a non-empty string",
      });
    } else if (s.micro_stages.some((m) => containsTodo(m))) {
      issues.push({
        scope: `${scope}.micro_stages`,
        severity: "warning",
        message: "contains TODO/REPLACE marker",
      });
    }
  }

  // pass_threshold
  if (
    typeof s.pass_threshold !== "number" ||
    !Number.isFinite(s.pass_threshold) ||
    s.pass_threshold < PASS_MIN ||
    s.pass_threshold > PASS_MAX
  ) {
    issues.push({
      scope: `${scope}.pass_threshold`,
      severity: "error",
      message: `must be in [${PASS_MIN}, ${PASS_MAX}], got ${s.pass_threshold}`,
    });
  }

  // vocabulary_set
  issues.push(
    ...validateVocabulary(s.vocabulary_set, `${scope}.vocabulary_set`),
  );

  // authoring metadata — warning only
  if (!s.authoring) {
    issues.push({
      scope: `${scope}.authoring`,
      severity: "warning",
      message: "no `authoring` block — scenario not signed off",
    });
  }

  return issues;
};

// ─────────────────────────────────────────────────────────────────────
// CLI entry point
// ─────────────────────────────────────────────────────────────────────

const formatIssue = (i: Issue) =>
  `  ${i.severity === "error" ? "✗" : "•"} [${i.scope}] ${i.message}`;

const main = () => {
  const files = loadScenarioFiles();

  const allIssues: Issue[] = [];
  const seenIds = new Set<string>();

  for (const f of files) {
    const parsed = parseScenario(f.id, f.raw);
    if (!parsed.ok) {
      allIssues.push(parsed.error);
      continue;
    }
    if (seenIds.has(parsed.data.scenario_id)) {
      allIssues.push({
        scope: "set",
        severity: "error",
        message: `duplicate scenario_id "${parsed.data.scenario_id}"`,
      });
    } else {
      seenIds.add(parsed.data.scenario_id);
    }
    allIssues.push(...validateScenario(f.id, parsed.data));
  }

  const errors = allIssues.filter((i) => i.severity === "error");
  const warnings = allIssues.filter((i) => i.severity === "warning");

  console.log(
    `Validated ${files.length} scenario file(s): ${errors.length} error(s), ${warnings.length} warning(s)`,
  );

  if (warnings.length > 0) {
    console.log(`\nWarnings:`);
    for (const w of warnings) console.log(formatIssue(w));
  }

  if (errors.length === 0) {
    console.log(
      `\n✓ all scenarios pass the schema — ${warnings.length > 0 ? "warnings remain (placeholders / missing sign-off)" : "ready for production"}`,
    );
    process.exit(0);
  }

  console.error(`\nErrors:`);
  for (const e of errors) console.error(formatIssue(e));
  console.error(
    `\nMinimums: ≥ ${MIN_VOCAB} vocab items per scenario, all 5 MVP languages present, pass_threshold ∈ [${PASS_MIN}, ${PASS_MAX}]`,
  );
  process.exit(1);
};

if (require.main === module) {
  main();
}
