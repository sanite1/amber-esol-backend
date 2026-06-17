/**
 * Three-beat scenario engine — AI Tutor Build Brief F25.
 *
 * Every AI tutor session runs the same three-beat arc:
 *
 *   PREPARE  → the warm lead-in (deterministic opening message; the
 *              learner reads the scenario + vocabulary before speaking)
 *   ROLEPLAY → the conversation itself, split into FOUR micro-stages
 *              (the four progress dots the learner sees). Each micro-
 *              stage is one "move" in the interaction — e.g. greet,
 *              give your details, handle a complication, close.
 *   COMPLETE → the warm closing message + the "what you did better"
 *              line + the chime.
 *
 * This module is the PURE state machine for that arc. It holds no DB
 * handle and performs no I/O — `aiSession.service.ts` reads the current
 * beat off the session document, calls `advanceBeat` with the signals
 * from the validated Gemini turn, and writes the result back. Keeping
 * it pure is what lets `sessionBeat.test.ts` exercise every transition
 * without a Gemini mock or a Mongo instance.
 *
 * HYBRID-ADAPTIVE, NO GATING (brief F25):
 *   A micro-stage advances when the AI reports `microStageComplete`.
 *   A weak attempt does NOT block progression — the AI recasts and
 *   moves on (the mode controller, F26, is what drops support to
 *   ANCHOR). A learner is never trapped on a dot they can't clear. The
 *   only thing that fills all four dots at once is session completion.
 */

export type Beat = "prepare" | "roleplay" | "complete";

/** Four micro-stages → four progress dots in the learner UI. */
export const MICRO_STAGE_COUNT = 4;

export interface BeatState {
  beat: Beat;
  /** Index of the micro-stage currently in play (0..MICRO_STAGE_COUNT-1). */
  microStageIndex: number;
  /** One flag per dot; `true` once that micro-stage is finished. */
  microStagesCompleted: boolean[];
}

export interface BeatSignals {
  /** Gemini's `microStageComplete` for the turn just processed. */
  microStageComplete: boolean;
  /** Gemini's `session_complete` for the turn just processed. */
  sessionComplete: boolean;
}

/** The arc state a brand-new session starts in. */
export const initialBeatState = (): BeatState => ({
  beat: "prepare",
  microStageIndex: 0,
  microStagesCompleted: new Array(MICRO_STAGE_COUNT).fill(false),
});

const clampIndex = (n: unknown): number => {
  const v = typeof n === "number" && Number.isFinite(n) ? Math.floor(n) : 0;
  if (v < 0) return 0;
  if (v > MICRO_STAGE_COUNT - 1) return MICRO_STAGE_COUNT - 1;
  return v;
};

/** Coerce a possibly-short / possibly-absent stored array to length 4. */
const normaliseCompleted = (raw: unknown): boolean[] => {
  const arr = Array.isArray(raw) ? raw.slice(0, MICRO_STAGE_COUNT) : [];
  const out: boolean[] = [];
  for (let i = 0; i < MICRO_STAGE_COUNT; i += 1) out.push(!!arr[i]);
  return out;
};

/**
 * Apply one turn's signals to the arc.
 *
 * Transitions (all idempotent and monotonic — beats never run
 * backwards, dots never un-fill):
 *   - The FIRST learner turn moves PREPARE → ROLEPLAY. PREPARE is the
 *     pre-conversation screen; once the learner speaks, the roleplay is
 *     underway, regardless of how that first turn scored.
 *   - In ROLEPLAY, `microStageComplete` fills the current dot and
 *     advances the index (capped at the last dot).
 *   - `sessionComplete` moves to COMPLETE and fills every remaining dot
 *     — the closing screen always shows a finished arc.
 */
export const advanceBeat = (
  prev: Partial<BeatState> | null | undefined,
  signals: BeatSignals,
): BeatState => {
  const completed = normaliseCompleted(prev?.microStagesCompleted);
  let beat: Beat = prev?.beat ?? "prepare";
  let index = clampIndex(prev?.microStageIndex);

  // PREPARE → ROLEPLAY on the first learner turn (no gating).
  if (beat === "prepare") beat = "roleplay";

  if (beat === "roleplay" && signals.microStageComplete) {
    completed[index] = true;
    index = Math.min(index + 1, MICRO_STAGE_COUNT - 1);
  }

  if (signals.sessionComplete) {
    beat = "complete";
    for (let i = 0; i < MICRO_STAGE_COUNT; i += 1) completed[i] = true;
    index = MICRO_STAGE_COUNT - 1;
  }

  return { beat, microStageIndex: index, microStagesCompleted: completed };
};

/**
 * Default four-stage arc used when a scenario file declares no
 * `micro_stages` of its own. Generic but real — every UK-life
 * interaction opens, exchanges information, handles a wrinkle, and
 * closes. Scenario authors override these with domain-specific labels
 * (e.g. "Describe your symptoms") in the scenario JSON.
 */
export const DEFAULT_MICRO_STAGES: readonly string[] = [
  "Open the conversation",
  "Exchange the key information",
  "Handle a question or complication",
  "Close and confirm",
];

/**
 * The label for the micro-stage currently in play — fed into Layer 5 so
 * the AI knows which move it is driving this turn. Falls back to the
 * default arc, then to a generic label, so a missing/short list never
 * throws.
 */
export const microStageLabel = (
  stages: readonly string[] | undefined,
  index: number,
): string => {
  const list =
    stages && stages.length === MICRO_STAGE_COUNT
      ? stages
      : DEFAULT_MICRO_STAGES;
  const i = clampIndex(index);
  return list[i] ?? DEFAULT_MICRO_STAGES[i] ?? `Stage ${i + 1}`;
};
