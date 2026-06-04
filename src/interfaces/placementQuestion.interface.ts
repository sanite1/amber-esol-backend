/**
 * Placement question bank — schema definitions (brief Function 6 To-Do 1).
 *
 * The bank lives at `src/data/placement-questions.json` and is loaded
 * by the placement scoring service. Validated at boot AND via the
 * `npm run validate:placement-bank` script that gates merges to main.
 *
 * Language coverage:
 *   - English (`en`) — authoritative source
 *   - Arabic (`ar`)
 *   - Somali (`so`)
 *   - Dari / Farsi (`fa`)
 *   - Chinese / Cantonese (`zh`)
 *
 * Pashto is in the wizard's UI-language list but not in the placement
 * bank — pending content from the curriculum lead. When Pashto lands,
 * add `question_ps` + `text_ps` to the schemas below and bump the
 * required-languages set in the validator.
 */

/** Five-rung ESOL scale used everywhere in Project Silk. */
export type EsolLevel = "e1" | "e2" | "e3" | "l1" | "l2";

/** Broad skill domains — not the ILR sub-codes. Placement scoring rolls
 *  the four domains; ILR sub-skill (Rt/Rs/Rw etc.) flagging happens
 *  downstream in `esolSkills.ts`. */
export type SkillDomain = "reading" | "writing" | "listening" | "speaking";

/** ISO 639-1-ish keys for the five MVP languages. */
export type PlacementLanguage = "en" | "ar" | "so" | "fa" | "zh";

/**
 * Per-language text payload. All five language keys are MANDATORY —
 * a missing translation fails the validator and blocks the merge.
 * Empty strings count as missing.
 */
export interface LocalisedText {
  text_en: string;
  text_ar: string;
  text_so: string;
  text_fa: string;
  text_zh: string;
}

/**
 * One multiple-choice option. `id` is a short stable token (typically
 * `"a"`–`"d"`); `correct_answer` on the parent question references this
 * `id`. We chose id-based references over string-equality so the
 * authoritative answer survives a translation re-pass that tweaks the
 * English text — translators can refine wording without breaking the
 * scoring contract.
 */
export interface PlacementOption extends LocalisedText {
  id: string;
}

/**
 * One question in the bank.
 *
 * `question_*` is the question stem in each language. For Reading
 * questions the stem may include a short passage; for Listening
 * questions it includes a transcript that the frontend converts to TTS.
 * Speaking questions use the stem as the prompt; the learner's spoken
 * answer is transcribed and matched against the options.
 *
 * `difficulty_weight` is a 0.5–2.0 multiplier applied during scoring.
 *   - 1.0 is the baseline ("average" question for the level)
 *   - 1.5–2.0 marks load-bearing questions whose outcome heavily
 *     influences level confidence
 *   - 0.5–0.8 marks lighter calibration items
 */
export interface PlacementQuestion {
  id: string;
  level: EsolLevel;
  skill_domain: SkillDomain;

  // Question stem — one per MVP language.
  question_en: string;
  question_ar: string;
  question_so: string;
  question_fa: string;
  question_zh: string;

  options: PlacementOption[];
  /** Must match one of `options[*].id`. Enforced by the validator. */
  correct_answer: string;
  /** 0.5 ≤ x ≤ 2.0 — see comment above. */
  difficulty_weight: number;
}

/** Whole-bank shape — what gets emitted from `placement-questions.json`. */
export interface PlacementBank {
  /** Bumped when the bank's content materially changes. The placement
   *  service stamps each PlacementAttempt with the version that scored
   *  it, so historical attempts remain reproducible. */
  version: number;
  questions: PlacementQuestion[];
}
