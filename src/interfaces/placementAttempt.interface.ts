import { Types, Document } from "mongoose";
import { EsolLevel, SkillDomain } from "./placementQuestion.interface";

/**
 * One learner's answer to one placement question.
 *
 * `was_correct` is derived from comparing `answer` against the bank's
 * `correct_answer` at submission time, then persisted so the adaptive
 * algorithm and the eventual scoring service don't have to re-derive
 * it (the bank can be revised; the historical truth is the snapshot).
 */
export interface AnsweredQuestion {
  question_id: string;
  answer: string; // option id the learner picked
  was_correct: boolean;
  answered_at: Date;
}

export type PlacementAttemptStatus =
  | "in_progress" // 0 ≤ answers.length < 20
  | "submitted" // answers.length === 20, awaiting Gemini scoring
  | "scored"; // result populated, attempt closed

/**
 * Result of the eventual Gemini scoring pass (brief Function 6 To-Do
 * 8.3). Populated by the scoring worker, NOT by the adaptive selection
 * algorithm. Defined here so the model + interface stay aligned even
 * before the scoring code lands.
 */
export interface PlacementResult {
  nqf_level: EsolLevel | null;
  /** 0..1 — how confident the scorer is in the level call. */
  placement_confidence: number | null;
  /** Per-domain pass/fail rollup, used by the wizard's confirmation screen. */
  skill_breakdown: Partial<
    Record<SkillDomain, { correct: number; total: number }>
  >;
  /** ILR skill codes the scorer flagged as weak (same shape as ForSkills import). */
  weakness_flags: string[];
  /** Plain-English summary the org admin sees verbatim. */
  rationale: string | null;
}

export interface IPlacementAttempt extends Document {
  _id: Types.ObjectId;
  learnerId: Types.ObjectId;
  orgId: Types.ObjectId;

  /** Bank version that scored this attempt — pinned at start so a
   *  mid-attempt bank revision doesn't change the question set. */
  bank_version: number;

  /** 20 question ids, in presentation order. Positions 6–20 may be
   *  rewritten exactly once by the adaptive recalc at answer 5. */
  selected_question_ids: string[];

  answers: AnsweredQuestion[];

  status: PlacementAttemptStatus;

  /** Timestamp the adaptive recalc fired. Null until answer 5 arrives;
   *  populated even when correctCount is in the mixed band (1–4), so an
   *  auditor sees the algorithm DID consider the recalc. */
  recalc_applied_at: Date | null;
  /** "all_correct" | "all_wrong" | "mixed" — what the recalc decided. */
  recalc_outcome: "all_correct" | "all_wrong" | "mixed" | null;

  startedAt: Date;
  submittedAt: Date | null;
  scoredAt: Date | null;

  result: PlacementResult | null;
}
