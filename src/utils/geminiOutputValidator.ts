import { z } from "zod";
import {
  GeminiSafeguardingCategory,
  GeminiTurnMode,
  IGeminiTurnOutput,
} from "../interfaces/geminiTurnOutput.interface";

/**
 * Zod schema for the Gemini AI tutor turn output — brief Function 7
 * To-Do 4.
 *
 * What's enforced:
 *   - All nine fields present (no `.optional()` anywhere)
 *   - Extra fields STRIPPED, not rejected. Earlier this was
 *     `.strict()` which rejected the whole turn whenever Gemini added
 *     a helpful auxiliary field (`grammar_feedback`, `hint`, etc.) —
 *     in practice that fired 502s on most turns. Stripping is the
 *     same posture we already take for off-list `skill_codes_used`
 *     and `vocabulary_items_used`: log + filter, don't reject.
 *   - `mode` ∈ the three-mode enum
 *   - `safeguarding_category` is either null or one of the six enum
 *     values
 *   - `turn_score` ∈ [0, 1]
 *   - Cross-field invariants:
 *       - safeguarding_flag === true → category required (non-null)
 *       - safeguarding_flag === false → category must be null
 *       - session_complete === true → summary required (non-empty)
 *       - session_complete === false → summary must be null
 *
 * What's NOT enforced (deliberately — log, don't reject):
 *   - skill_codes_used membership in the 9-code ILR set. Gemini drifts
 *     here under load ("Sp" instead of "Sc"); rejecting the whole turn
 *     for one drifted code is worse than recording the drift. The
 *     aggregator filters to the canonical set.
 *   - vocabulary_items_used membership in the scenario's vocabulary set.
 *     Same reason — log + filter downstream.
 */

const MODE_VALUES: readonly GeminiTurnMode[] = [
  "anchor",
  "bridge",
  "immersion",
] as const;

const SAFEGUARDING_CATEGORIES: readonly GeminiSafeguardingCategory[] = [
  "self_harm",
  "domestic_abuse",
  "radicalisation",
  "child_protection",
  "exploitation",
  "mental_health_crisis",
] as const;

export const geminiTurnOutputSchema = z
  .object({
    reply: z.string().min(1, "reply must be a non-empty string"),
    mode: z.enum(MODE_VALUES as [GeminiTurnMode, ...GeminiTurnMode[]]),
    skill_codes_used: z.array(z.string()),
    turn_score: z
      .number()
      .min(0, "turn_score must be ≥ 0")
      .max(1, "turn_score must be ≤ 1"),
    vocabulary_items_used: z.array(z.string()),
    safeguarding_flag: z.boolean(),
    safeguarding_category: z
      .enum(
        SAFEGUARDING_CATEGORIES as [
          GeminiSafeguardingCategory,
          ...GeminiSafeguardingCategory[],
        ],
      )
      .nullable(),
    session_complete: z.boolean(),
    session_summary: z.string().min(1).nullable(),
    // ── F23/F24 contract additions ────────────────────────────────
    // Optional-with-default: the model SHOULD return these (the
    // response schema asks for them), but a turn must never FAIL for
    // omitting one — a missing evidence signal degrades gracefully,
    // it doesn't break the learner's reply.
    replyLang: z
      .enum(["l1", "en", "mixed"] as ["l1", "en", "mixed"])
      .default("mixed"),
    microStageComplete: z.boolean().default(false),
    recastApplied: z.boolean().default(false),
    emotional_state: z
      .enum(["engaged", "neutral", "frustrated", "anxious", "withdrawn"] as [
        string,
        ...string[],
      ])
      .nullable()
      .default(null),
    // ── F32 speaking turns ────────────────────────────────────────
    // The tutor sets this when it asks the learner to say ONE short
    // phrase aloud. Optional, default null — a typed-only deploy never
    // sees it and a turn must never fail for omitting it.
    speaking_prompt: z
      .object({
        expects_speech: z.boolean().default(false),
        target_phrase: z.string().nullable().default(null),
      })
      .strip()
      .nullable()
      .default(null),
  })
  // .strip() (the Zod default) drops unknown keys silently rather than
  // erroring. Explicit here for the next reader who wonders why we
  // moved off .strict().
  .strip()
  // ── Cross-field invariants ────────────────────────────────────────
  .refine(
    (v) => (v.safeguarding_flag ? v.safeguarding_category !== null : true),
    {
      message:
        "safeguarding_category is required when safeguarding_flag is true",
      path: ["safeguarding_category"],
    },
  )
  .refine(
    (v) => (!v.safeguarding_flag ? v.safeguarding_category === null : true),
    {
      message:
        "safeguarding_category must be null when safeguarding_flag is false",
      path: ["safeguarding_category"],
    },
  )
  .refine(
    (v) =>
      v.session_complete
        ? typeof v.session_summary === "string" && v.session_summary.length > 0
        : true,
    {
      message:
        "session_summary is required (2–3 sentences) when session_complete is true",
      path: ["session_summary"],
    },
  )
  .refine((v) => (!v.session_complete ? v.session_summary === null : true), {
    message: "session_summary must be null when session_complete is false",
    path: ["session_summary"],
  });

/**
 * Validate one Gemini turn output. Throws `Error` with a summarised
 * message on failure — `gemini.service.ts` wraps that in
 * `GeminiSchemaError` and attaches the raw body for the caller's log.
 *
 * The throw form (rather than Result<T, E>) matches the existing
 * callsite shape in `gemini.service.ts` where validation runs inside
 * a try/catch.
 */
export const validateGeminiTurnOutput = (
  parsed: unknown,
): IGeminiTurnOutput => {
  const result = geminiTurnOutputSchema.safeParse(parsed);
  if (!result.success) {
    // Compact issue list — Zod's default formatter is verbose for logs.
    const issues = result.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new Error(`Gemini output schema validation failed: ${issues}`);
  }
  return result.data as IGeminiTurnOutput;
};

// Inferred type for callers that want the Zod-derived shape.
export type GeminiTurnOutput = z.infer<typeof geminiTurnOutputSchema>;
