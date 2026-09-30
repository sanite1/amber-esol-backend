/**
 * Tutor eval harness — pure checks (Silk brief section 3).
 *
 * Automatic checks catch the mechanical failures (wrong language
 * share, banned words, generic praise, missing recast, unstable
 * scores). They cannot judge whether a recast is grammatical: those
 * cases are marked `specialist_review: true` in the case file and the
 * report leaves a column for a DELTA qualified ESOL specialist.
 */

export type EvalLevel = "e1" | "e2" | "e3" | "l1" | "l2";

export interface TutorEvalCase {
  id: string;
  /** Why this case exists, in one line. */
  purpose: string;
  level: EvalLevel;
  l1Language: string;
  scenarioId: string;
  /** Prior turns, oldest first. */
  history: Array<{ role: "user" | "model"; content: string }>;
  learnerInput: string;
  expect: {
    /** Minimum share of English words in the reply (0..1). */
    minEnglishShare?: number;
    /** Maximum share of English words in the reply (0..1). */
    maxEnglishShare?: number;
    /** Every regex here must match the reply (case insensitive). */
    mustMatch?: string[];
    /** No regex here may match the reply (case insensitive). */
    mustNotMatch?: string[];
    /** Expected recastApplied flag. */
    recastApplied?: boolean;
    /** Expected mode from the model. */
    mode?: "anchor" | "bridge" | "immersion";
    /** turn_score band. */
    scoreMin?: number;
    scoreMax?: number;
    /** Max spread of turn_score across repeated runs. */
    scoreSpreadMax?: number;
  };
  /** Grammar sensitive: a specialist must mark the recast by hand. */
  specialist_review?: boolean;
}

export interface TurnOutputForEval {
  reply: string;
  mode: string;
  turn_score: number;
  recastApplied?: boolean | null;
  replyLang?: string | null;
}

/** Layer 2 rule 4 plus the generic praise Layer 1 forbids. */
export const BANNED_PATTERNS: string[] = [
  "\\bquickly\\b",
  "\\bjust\\b",
  "\\beasy\\b",
  "\\bsimply\\b",
  "\\bstraightforward\\b",
  "\\bobviously\\b",
  "\\bas you know\\b",
  "\\bgreat job\\b",
  "\\bgood job\\b",
  "\\bthat is incorrect\\b",
  "\\bthat's incorrect\\b",
  "\\bthat is wrong\\b",
];

/** Turkish function words that are plain ASCII and so would otherwise
 *  count as English. Small on purpose; diacritics catch most Turkish. */
const TURKISH_ASCII_WORDS = new Set([
  "ve",
  "bir",
  "bu",
  "ne",
  "mi",
  "mu",
  "da",
  "de",
  "ben",
  "sen",
  "biz",
  "siz",
  "o",
  "evet",
  "hayir",
  "nasil",
  "iyi",
  "tamam",
  "harika",
  "peki",
  "ama",
  "veya",
  "ile",
  "icin",
  "gibi",
  "daha",
  "cok",
  "az",
  "var",
  "yok",
  "simdi",
  "sonra",
  "once",
  "burada",
  "orada",
  "kim",
  "neden",
  "hangi",
  "sey",
  "seni",
  "sana",
  "bana",
  "beni",
  "bize",
  "size",
  "onun",
  "onlar",
]);

const TOKEN_RE = /[\p{L}\p{M}'’-]+/gu;

const isEnglishToken = (raw: string): boolean => {
  const t = raw.toLowerCase();
  if (!/^[a-z'’-]+$/.test(t)) return false; // any diacritic or non Latin → not English
  if (TURKISH_ASCII_WORDS.has(t)) return false;
  return true;
};

/**
 * Share of word tokens that look English (0..1). Non Latin scripts and
 * words with diacritics count as first language. Returns 1 for an empty
 * reply so an empty reply fails on other checks, not this one.
 */
export const englishShare = (text: string): number => {
  const tokens = text.match(TOKEN_RE) ?? [];
  if (tokens.length === 0) return 1;
  const en = tokens.filter(isEnglishToken).length;
  return en / tokens.length;
};

export const bannedWordsIn = (text: string): string[] =>
  BANNED_PATTERNS.filter((p) => new RegExp(p, "i").test(text)).map((p) =>
    p.replace(/\\b/g, ""),
  );

export interface EvalFinding {
  check: string;
  passed: boolean;
  detail: string;
}

/** Check one model output against a case. Pure. */
export const checkTurnOutput = (
  c: TutorEvalCase,
  out: TurnOutputForEval,
): EvalFinding[] => {
  const f: EvalFinding[] = [];
  const share = englishShare(out.reply);
  const e = c.expect;

  if (typeof e.minEnglishShare === "number") {
    f.push({
      check: "english_share_min",
      passed: share >= e.minEnglishShare,
      detail: `${Math.round(share * 100)}% English, floor ${Math.round(e.minEnglishShare * 100)}%`,
    });
  }
  if (typeof e.maxEnglishShare === "number") {
    f.push({
      check: "english_share_max",
      passed: share <= e.maxEnglishShare,
      detail: `${Math.round(share * 100)}% English, ceiling ${Math.round(e.maxEnglishShare * 100)}%`,
    });
  }
  for (const re of e.mustMatch ?? []) {
    const ok = new RegExp(re, "i").test(out.reply);
    f.push({ check: "must_match", passed: ok, detail: re });
  }
  for (const re of e.mustNotMatch ?? []) {
    const hit = new RegExp(re, "i").test(out.reply);
    f.push({ check: "must_not_match", passed: !hit, detail: re });
  }
  const banned = bannedWordsIn(out.reply);
  f.push({
    check: "banned_words",
    passed: banned.length === 0,
    detail: banned.length ? banned.join(", ") : "none",
  });
  if (typeof e.recastApplied === "boolean") {
    f.push({
      check: "recast_applied",
      passed: !!out.recastApplied === e.recastApplied,
      detail: `got ${String(out.recastApplied)}, want ${e.recastApplied}`,
    });
  }
  if (e.mode) {
    f.push({
      check: "mode",
      passed: out.mode.toLowerCase() === e.mode,
      detail: `got ${out.mode.toLowerCase()}, want ${e.mode}`,
    });
  }
  if (typeof e.scoreMin === "number") {
    f.push({
      check: "score_min",
      passed: out.turn_score >= e.scoreMin,
      detail: `score ${out.turn_score}, floor ${e.scoreMin}`,
    });
  }
  if (typeof e.scoreMax === "number") {
    f.push({
      check: "score_max",
      passed: out.turn_score <= e.scoreMax,
      detail: `score ${out.turn_score}, ceiling ${e.scoreMax}`,
    });
  }
  return f;
};

/** Stability across repeated runs of the same case. */
export const checkStability = (
  c: TutorEvalCase,
  outs: TurnOutputForEval[],
): EvalFinding[] => {
  if (outs.length < 2) return [];
  const scores = outs.map((o) => o.turn_score);
  const spread = Math.max(...scores) - Math.min(...scores);
  const recasts = new Set(outs.map((o) => !!o.recastApplied));
  const f: EvalFinding[] = [
    {
      check: "score_spread",
      passed: spread <= (c.expect.scoreSpreadMax ?? 0.2),
      detail: `scores ${scores.join(", ")} (spread ${spread.toFixed(2)})`,
    },
    {
      check: "recast_consistent",
      passed: recasts.size === 1,
      detail:
        recasts.size === 1
          ? "same decision every run"
          : "recast appeared in some runs and not others",
    },
  ];
  return f;
};

/** Validate the case file shape so a bad edit fails in CI, not live. */
export const validateCases = (cases: unknown): string[] => {
  const errors: string[] = [];
  if (!Array.isArray(cases)) return ["case file must be an array"];
  const ids = new Set<string>();
  cases.forEach((c, i) => {
    const x = c as Partial<TutorEvalCase>;
    const at = `case[${i}]${x?.id ? ` ${x.id}` : ""}`;
    if (!x || typeof x !== "object") return errors.push(`${at}: not an object`);
    if (!x.id) errors.push(`${at}: id missing`);
    else if (ids.has(x.id)) errors.push(`${at}: duplicate id`);
    else ids.add(x.id);
    if (!["e1", "e2", "e3", "l1", "l2"].includes(x.level as string))
      errors.push(`${at}: level invalid`);
    if (!x.l1Language) errors.push(`${at}: l1Language missing`);
    if (!x.scenarioId) errors.push(`${at}: scenarioId missing`);
    if (!Array.isArray(x.history))
      errors.push(`${at}: history must be an array`);
    if (!x.learnerInput) errors.push(`${at}: learnerInput missing`);
    if (!x.expect || typeof x.expect !== "object")
      errors.push(`${at}: expect missing`);
    for (const re of [
      ...(x.expect?.mustMatch ?? []),
      ...(x.expect?.mustNotMatch ?? []),
    ]) {
      try {
        new RegExp(re, "i");
      } catch {
        errors.push(`${at}: bad regex ${re}`);
      }
    }
  });
  return errors;
};
