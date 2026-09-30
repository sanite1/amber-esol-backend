/**
 * Deterministic per turn score — Silk brief section 3 PROPOSAL.
 *
 * Today `turn_score` comes from the same JSON call as the reply, so the
 * model grades itself ("ok" scored 1.0, a real answer 0.6). This module
 * computes a score from observable features of the learner's message
 * so the number is reproducible and explainable.
 *
 * Behind TURN_SCORE_MODE:
 *   model         (default) keep the model's self score, unchanged
 *   deterministic use this score
 *   blend         mean of the two
 *
 * Both values are traced on every turn whatever the mode, so the
 * specialist can compare them over real sessions before the default
 * changes. The weights below are a starting point for calibration,
 * not a validated rubric.
 */

import type { EsolLevel } from "../interfaces/placementQuestion.interface";
import { englishShare } from "../eval/tutorEvalChecks";

export type TurnScoreMode = "model" | "deterministic" | "blend";

export const turnScoreMode = (): TurnScoreMode => {
  const v = (process.env.TURN_SCORE_MODE ?? "model").toLowerCase();
  return v === "deterministic" || v === "blend" ? v : "model";
};

/** Words a learner at each level is expected to produce per turn. */
const TARGET_WORDS: Record<EsolLevel, number> = {
  e1: 4,
  e2: 7,
  e3: 12,
  l1: 18,
  l2: 25,
};

export interface DeterministicScoreInput {
  learnerMessage: string;
  level: EsolLevel;
  /** The model recast a meaning affecting error this turn. */
  recastApplied?: boolean | null;
  /** Target vocabulary the learner used this turn. */
  vocabularyUsed?: string[];
  /** The learner signalled confusion or distress (mode controller). */
  distress?: boolean;
}

export interface DeterministicScore {
  score: number;
  features: {
    words: number;
    english_share: number;
    length_ratio: number;
    vocab_used: number;
    recast: boolean;
    distress: boolean;
  };
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const round2 = (n: number) => Math.round(n * 100) / 100;

export const deterministicTurnScore = (
  input: DeterministicScoreInput,
): DeterministicScore => {
  const words = (input.learnerMessage.match(/[\p{L}\p{M}'’-]+/gu) ?? []).length;
  const share = englishShare(input.learnerMessage);
  const target = TARGET_WORDS[input.level] ?? TARGET_WORDS.e2;
  const lengthRatio = clamp01(words / target);
  const vocabUsed = (input.vocabularyUsed ?? []).length;
  const recast = !!input.recastApplied;

  // The English share is scaled by how much the learner produced for
  // the level: "ok" is 100% English and still not a real answer. Using
  // target vocabulary is a small bonus; a recast (an error worth
  // modelling) costs a little; one or two word turns are capped; a
  // distress turn is capped so ANCHOR triggers.
  let score =
    share * (0.25 + 0.75 * lengthRatio) + Math.min(0.15, 0.05 * vocabUsed);
  if (recast) score -= 0.1;
  if (words === 0) score = 0;
  if (words <= 2) score = Math.min(score, 0.3);
  if (input.distress) score = Math.min(score, 0.35);

  return {
    score: round2(clamp01(score)),
    features: {
      words,
      english_share: round2(share),
      length_ratio: round2(lengthRatio),
      vocab_used: vocabUsed,
      recast,
      distress: !!input.distress,
    },
  };
};

/** Combine the model's self score with the deterministic one per mode. */
export const resolveTurnScore = (
  modelScore: number,
  deterministic: number,
  mode: TurnScoreMode = turnScoreMode(),
): number => {
  if (mode === "deterministic") return deterministic;
  if (mode === "blend") return round2((modelScore + deterministic) / 2);
  return modelScore;
};
