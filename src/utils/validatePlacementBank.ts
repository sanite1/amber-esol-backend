/* eslint-disable no-console */
/**
 * Placement question-bank validator — brief Function 6 To-Do 1.
 *
 * Runs as `npm run validate:placement-bank`. Exits 0 on a clean bank,
 * non-zero on any structural problem. CI gates merges on this exit
 * code so a malformed bank can never reach production.
 *
 * Checks (in order — all run, all errors collected):
 *
 *   1. JSON parses                          (else FATAL — abort)
 *   2. Top-level shape matches PlacementBank
 *   3. Question count ≥ MIN_QUESTIONS (80)
 *   4. Each (level × domain) cell has ≥ MIN_PER_CELL (4) questions
 *   5. Per-question schema:
 *        - id present and unique
 *        - level + skill_domain enum-valid
 *        - all five `question_*` strings non-empty
 *        - options non-empty, ids unique, every option has all five
 *          `text_*` strings non-empty
 *        - correct_answer matches one of options[*].id
 *        - difficulty_weight ∈ [DIFFICULTY_MIN, DIFFICULTY_MAX]
 *
 * Design rationale:
 *   - We don't stop at the first error — the curriculum author wants
 *     to see every problem in one pass.
 *   - All errors are prefixed with the question id (or row index when
 *     the id is missing) so they're greppable from a CI log.
 *   - This file has zero runtime deps beyond Node + a JSON file read,
 *     so it can run before `npm install` finishes if needed.
 */

import { readFileSync } from "fs";
import { resolve } from "path";

import {
  PlacementBank,
  PlacementQuestion,
  PlacementOption,
  EsolLevel,
  SkillDomain,
  PlacementLanguage,
} from "../interfaces/placementQuestion.interface";

// ─────────────────────────────────────────────────────────────────────
// Configuration — change here, not inline
// ─────────────────────────────────────────────────────────────────────

const BANK_PATH = resolve(__dirname, "../data/placement-questions.json");

const MIN_QUESTIONS = 80;
const MIN_PER_CELL = 4;
const DIFFICULTY_MIN = 0.5;
const DIFFICULTY_MAX = 2.0;

const LEVELS: EsolLevel[] = ["e1", "e2", "e3", "l1", "l2"];
const DOMAINS: SkillDomain[] = ["reading", "writing", "listening", "speaking"];
const LANGS: PlacementLanguage[] = ["en", "ar", "so", "fa", "zh"];

const QUESTION_FIELDS: Record<PlacementLanguage, keyof PlacementQuestion> = {
  en: "question_en",
  ar: "question_ar",
  so: "question_so",
  fa: "question_fa",
  zh: "question_zh",
};

const OPTION_FIELDS: Record<PlacementLanguage, keyof PlacementOption> = {
  en: "text_en",
  ar: "text_ar",
  so: "text_so",
  fa: "text_fa",
  zh: "text_zh",
};

// ─────────────────────────────────────────────────────────────────────
// Validator
// ─────────────────────────────────────────────────────────────────────

interface ValidationError {
  /** "Q123" / "Q[5]" / "bank" — used as the row prefix. */
  scope: string;
  message: string;
}

const isNonEmptyString = (v: unknown): v is string =>
  typeof v === "string" && v.trim().length > 0;

const loadBank = (path: string): PlacementBank => {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    console.error(`FATAL: cannot read ${path}`);
    console.error(err);
    process.exit(2);
  }
  try {
    return JSON.parse(raw) as PlacementBank;
  } catch (err) {
    console.error(`FATAL: ${path} is not valid JSON`);
    console.error(err);
    process.exit(2);
  }
};

const validateShape = (bank: unknown): ValidationError[] => {
  const errors: ValidationError[] = [];
  if (!bank || typeof bank !== "object") {
    errors.push({
      scope: "bank",
      message: "root must be a JSON object with { version, questions }",
    });
    return errors;
  }
  const b = bank as Partial<PlacementBank>;
  if (typeof b.version !== "number" || b.version < 1) {
    errors.push({
      scope: "bank",
      message: "`version` must be a positive integer",
    });
  }
  if (!Array.isArray(b.questions)) {
    errors.push({ scope: "bank", message: "`questions` must be an array" });
  }
  return errors;
};

const validateCounts = (questions: PlacementQuestion[]): ValidationError[] => {
  const errors: ValidationError[] = [];

  if (questions.length < MIN_QUESTIONS) {
    errors.push({
      scope: "bank",
      message: `expected at least ${MIN_QUESTIONS} questions, got ${questions.length}`,
    });
  }

  // (level × domain) → count
  const cells = new Map<string, number>();
  for (const q of questions) {
    const key = `${q.level}/${q.skill_domain}`;
    cells.set(key, (cells.get(key) ?? 0) + 1);
  }
  for (const level of LEVELS) {
    for (const domain of DOMAINS) {
      const key = `${level}/${domain}`;
      const count = cells.get(key) ?? 0;
      if (count < MIN_PER_CELL) {
        errors.push({
          scope: "bank",
          message: `cell ${key} has ${count} question(s); need ≥ ${MIN_PER_CELL}`,
        });
      }
    }
  }

  return errors;
};

const validateQuestion = (
  q: PlacementQuestion,
  scope: string,
  seenIds: Set<string>
): ValidationError[] => {
  const errors: ValidationError[] = [];

  // id
  if (!isNonEmptyString(q.id)) {
    errors.push({ scope, message: "`id` is required" });
  } else if (seenIds.has(q.id)) {
    errors.push({ scope, message: `duplicate id ${q.id}` });
  } else {
    seenIds.add(q.id);
  }

  // level / domain
  if (!LEVELS.includes(q.level)) {
    errors.push({
      scope,
      message: `level "${q.level}" must be one of ${LEVELS.join(", ")}`,
    });
  }
  if (!DOMAINS.includes(q.skill_domain)) {
    errors.push({
      scope,
      message: `skill_domain "${q.skill_domain}" must be one of ${DOMAINS.join(", ")}`,
    });
  }

  // question_* in every MVP language
  for (const lang of LANGS) {
    const field = QUESTION_FIELDS[lang];
    if (!isNonEmptyString(q[field] as unknown as string)) {
      errors.push({
        scope,
        message: `${field} is required and must be non-empty`,
      });
    }
  }

  // options
  if (!Array.isArray(q.options) || q.options.length < 2) {
    errors.push({
      scope,
      message: "options must be an array with at least 2 entries",
    });
  } else {
    const optionIds = new Set<string>();
    q.options.forEach((opt, i) => {
      const optScope = `${scope} option[${i}]`;
      if (!isNonEmptyString(opt.id)) {
        errors.push({ scope: optScope, message: "option.id is required" });
      } else if (optionIds.has(opt.id)) {
        errors.push({
          scope: optScope,
          message: `duplicate option id "${opt.id}" within question`,
        });
      } else {
        optionIds.add(opt.id);
      }
      for (const lang of LANGS) {
        const field = OPTION_FIELDS[lang];
        if (!isNonEmptyString(opt[field] as unknown as string)) {
          errors.push({
            scope: optScope,
            message: `${field} is required and must be non-empty`,
          });
        }
      }
    });

    // correct_answer must match an existing option id
    if (!isNonEmptyString(q.correct_answer)) {
      errors.push({ scope, message: "`correct_answer` is required" });
    } else if (!optionIds.has(q.correct_answer)) {
      errors.push({
        scope,
        message: `correct_answer "${q.correct_answer}" does not match any option.id (${[...optionIds].join(", ") || "<none>"})`,
      });
    }
  }

  // difficulty_weight
  if (
    typeof q.difficulty_weight !== "number" ||
    !Number.isFinite(q.difficulty_weight) ||
    q.difficulty_weight < DIFFICULTY_MIN ||
    q.difficulty_weight > DIFFICULTY_MAX
  ) {
    errors.push({
      scope,
      message: `difficulty_weight must be a number in [${DIFFICULTY_MIN}, ${DIFFICULTY_MAX}], got ${q.difficulty_weight}`,
    });
  }

  return errors;
};

export const validatePlacementBank = (
  path: string = BANK_PATH
): { errors: ValidationError[]; bank: PlacementBank } => {
  const bank = loadBank(path);

  const errors: ValidationError[] = [];
  errors.push(...validateShape(bank));

  if (Array.isArray(bank.questions)) {
    errors.push(...validateCounts(bank.questions));

    const seenIds = new Set<string>();
    bank.questions.forEach((q, idx) => {
      const scope = isNonEmptyString((q as PlacementQuestion).id)
        ? `Q[${idx}] ${(q as PlacementQuestion).id}`
        : `Q[${idx}]`;
      errors.push(...validateQuestion(q as PlacementQuestion, scope, seenIds));
    });
  }

  return { errors, bank };
};

// ─────────────────────────────────────────────────────────────────────
// CLI entry point
// ─────────────────────────────────────────────────────────────────────

const formatError = (e: ValidationError) => `  [${e.scope}] ${e.message}`;

const main = () => {
  const { errors, bank } = validatePlacementBank();
  const total = Array.isArray(bank.questions) ? bank.questions.length : 0;

  if (errors.length === 0) {
    console.log(
      `✓ placement bank OK — ${total} questions, version ${bank.version}`
    );
    process.exit(0);
  }

  console.error(`✗ placement bank invalid — ${errors.length} problem(s):`);
  for (const e of errors) console.error(formatError(e));
  console.error(`\nTotal questions parsed: ${total}`);
  console.error(
    `Minimum required: ${MIN_QUESTIONS} (≥${MIN_PER_CELL} per level × domain cell)`
  );
  process.exit(1);
};

if (require.main === module) {
  main();
}
