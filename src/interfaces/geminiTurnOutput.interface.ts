/**
 * Gemini AI tutor turn output — brief Function 7 To-Do 4.
 *
 * Every Gemini AI-tutor call returns EXACTLY this shape. Validated at
 * the gemini.service.ts boundary; a violation throws GeminiSchemaError
 * with the truncated raw body attached for diagnosis.
 *
 * This is the CONTRACT — Layer 6 of the system prompt instructs
 * Gemini to produce it, the response-schema field on the
 * generationConfig declares it to Vertex, and the validator enforces
 * it on the way back. Three layers of defence because LLMs ignore
 * structural constraints under load.
 *
 * Other Gemini surfaces (placement scoring, RARPA evidence synthesis)
 * have their own schemas — this file is the tutor-turn schema only.
 */

/**
 * Mode the model recommends for the NEXT turn — lowercase per the
 * brief. The existing AISession schema stores `sessionMode` in
 * uppercase ("BRIDGE" / "ANCHOR" / "IMMERSION"); the orchestration
 * layer normalises between the two.
 */
export type GeminiTurnMode = "anchor" | "bridge" | "immersion";

/**
 * Closed set of safeguarding categories. Derived from Layer 2 of the
 * system prompt (`layer2-hard-rules.md`):
 *
 *   - self_harm            — self-harm / suicidal ideation
 *   - domestic_abuse       — current or recent IPV
 *   - radicalisation       — concerns about themselves or others
 *   - child_protection     — child at risk
 *   - exploitation         — labour, trafficking, financial
 *   - mental_health_crisis — acute mental-health distress
 *
 * The category is `null` when `safeguarding_flag` is false. The
 * validator enforces the cross-field rule: flag → category required,
 * no flag → category must be null.
 */
export type GeminiSafeguardingCategory =
  | "self_harm"
  | "domestic_abuse"
  | "radicalisation"
  | "child_protection"
  | "exploitation"
  | "mental_health_crisis";

export interface IGeminiTurnOutput {
  /** The user-visible reply — the only field a learner sees. */
  reply: string;

  /** Recommended mode for the next turn. */
  mode: GeminiTurnMode;

  /**
   * ILR skill codes practised in this turn. Subset of the 9 codes
   * declared in `esolSkills.ts` (Sc/Sd/Lr/Rt/Rs/Rw/Wt/Ws/Ww). The
   * validator does NOT check membership of that set — Gemini
   * occasionally invents adjacent codes ("Sp" for speaking instead of
   * "Sc"), and we'd rather log the drift than reject the turn. The
   * caller's aggregation step (Function 9 To-Do 5) filters to the
   * canonical set.
   */
  skill_codes_used: string[];

  /** 0..1. The model's self-rating of how well the learner did this
   *  turn. Drives mode-switch decisions and Stage 4 evidence. */
  turn_score: number;

  /** Vocabulary items from the scenario's `vocabulary_set` that
   *  Gemini wove into THIS turn. The aggregator counts these toward
   *  the learner's reinforcement totals. */
  vocabulary_items_used: string[];

  /** True when this turn surfaced one of the safeguarding categories. */
  safeguarding_flag: boolean;

  /** Required when `safeguarding_flag` is true; must be null otherwise. */
  safeguarding_category: GeminiSafeguardingCategory | null;

  /** True when Gemini determines the session has hit its pass
   *  threshold or natural end. */
  session_complete: boolean;

  /** Required when `session_complete` is true; null otherwise.
   *  2–3 sentence closing message in L1 + English (see Layer 6 of
   *  the system prompt for the wording rules). */
  session_summary: string | null;
}
