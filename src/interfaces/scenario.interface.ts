/**
 * Scenario schema — brief Function 7 To-Do 2.
 *
 * MVP scenarios live as JSON files in src/data/scenarios/. Each file
 * matches `IScenarioFile`; the validator at
 * `src/scripts/validateScenarios.ts` enforces the rules below before
 * any scenario is loaded into the AI tutor.
 *
 * Five MVP languages are the same set the placement bank uses:
 *   en — English (authoritative source)
 *   ar — Arabic
 *   so — Somali
 *   fa — Dari / Farsi
 *   zh — Cantonese / Traditional Chinese
 *
 * Pashto is in the wizard UI but not in scenarios (no Pashto
 * translator engaged for v1).
 */

import { EsolLevel } from "./placementQuestion.interface";

/** ILR Skills for Life sub-skill codes — same set as esolSkills.ts. */
export type IlrSkillCode =
  | "Rt"
  | "Rs"
  | "Rw"
  | "Wt"
  | "Ws"
  | "Ww"
  | "Lr"
  | "Sc"
  | "Sd";

/**
 * Stage 3 RARPA "anchor" ILR codes — what objective(s) this scenario
 * contributes evidence toward.
 *
 * Brief Function 8 To-Do 3 specifies skill CODES here (e.g. ["Sc", "Lr"]),
 * NOT domain names. The four anchors map to the four ForSkills domains
 * via DOMAIN_TO_ANCHOR in esolSkills.ts:
 *   Sc → speaking
 *   Lr → listening
 *   Rt → reading
 *   Wt → writing
 *
 * Sub-codes (Sd, Rs, Rw, Ws, Ww) are NOT used at this layer — the
 * learner's `stage3_objectives.skill_domain` is always the anchor code
 * or the "general" sentinel (see rarpa.service.ts).
 */
export type Stage3ObjectiveAnchor = "Sc" | "Lr" | "Rt" | "Wt";

/** @deprecated use Stage3ObjectiveAnchor — kept transiently for any
 *  external consumer that imports Stage3Domain. */
export type Stage3Domain = Stage3ObjectiveAnchor;

/** Languages with full bank coverage. en is always present. */
export type ScenarioLanguage = "en" | "ar" | "so" | "fa" | "zh";

/**
 * Inclusive level range — the scenario is available to learners
 * whose esolLevel is `min ≤ level ≤ max` on the e1→l2 scale.
 *
 *   s1_gp_appointment:    e1-e3
 *   s2_payslip:            e2-l1
 *   s3_housing_rights:     e2-l1
 *
 * Stored as min/max so the matching service can do a range query
 * without needing to enumerate the full e1/e2/e3/l1/l2 set.
 */
export interface NqfLevelRange {
  min: EsolLevel;
  max: EsolLevel;
}

/** Multilingual text payload — en is authoritative. */
export interface MultilingualText {
  en: string;
  ar: string;
  so: string;
  fa: string;
  zh: string;
}

/**
 * One vocabulary item taught in the scenario. `reinforcement_weight`
 * tells the AI tutor how often to weave this word back into dialogue
 * across the session:
 *   1.0 — core item, must appear ≥ 2 turns
 *   0.5 — secondary item, appears 1 turn if conversation permits
 *   0.0 — passive item, only counted if the LEARNER uses it
 *
 * `translations` covers the four non-English MVP languages. The
 * English definition lives in `definition_en` because explaining a
 * word in itself is the canonical ESOL approach.
 */
export interface VocabularyItem {
  word: string;
  definition_en: string;
  translations: {
    ar: string;
    so: string;
    fa: string;
    zh: string;
  };
  example_sentence: string;
  reinforcement_weight: number;
}

/**
 * Complete scenario file shape — what each JSON in src/data/scenarios/
 * must satisfy.
 *
 * Authoring rules (enforced by the validator):
 *   - `vocabulary_set` has ≥ 20 items
 *   - `pass_threshold` ∈ [0.6, 0.9]
 *   - `title` has all 5 MVP language entries, all non-empty
 *   - `cultural_notes` has all 5 MVP language entries (en authoritative,
 *     others can mirror but must be non-empty)
 *   - every vocabulary item has all 4 non-English translations populated
 *   - `nqf_level_range.min` ≤ `nqf_level_range.max` on the e1→l2 scale
 *   - `skill_codes` non-empty, every value a valid IlrSkillCode
 *   - `stage3_objective_domains` non-empty
 */
export interface IScenarioFile {
  scenario_id: string;
  title: MultilingualText;
  nqf_level_range: NqfLevelRange;
  skill_codes: IlrSkillCode[];
  stage3_objective_domains: Stage3ObjectiveAnchor[];
  vocabulary_set: VocabularyItem[];
  grammar_targets: string[];
  roleplay_prompt_en: string;
  pass_threshold: number;
  cultural_notes_en: string;
  cultural_notes_ar: string;
  cultural_notes_so: string;
  cultural_notes_fa: string;
  cultural_notes_zh: string;

  /**
   * Optional version + provenance metadata. The translation lead
   * stamps this when a translator + ESOL practitioner have signed off.
   * The validator doesn't enforce its presence (a v0.1 draft scenario
   * has no sign-off yet) but warns when missing on a scenario that
   * other fields suggest is launch-ready.
   */
  authoring?: {
    version: string;
    english_author?: string;
    translators?: Partial<Record<ScenarioLanguage, string>>;
    esol_practitioner_reviewer?: string;
    signed_off_at?: string; // ISO date
  };
}
