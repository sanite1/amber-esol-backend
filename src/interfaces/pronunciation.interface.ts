/**
 * F32 speaking turns — shared wire types.
 *
 * These shapes are part of the frontend contract (esolApi.ts mirrors
 * them field for field). Do not rename fields without a matching
 * frontend change.
 */

export type PronunciationClarity = "clear" | "mostly_clear" | "unclear";

export type PronunciationMethod = "gemini_audio" | "stt_confidence" | "mock";

/** Pronunciation assessment of ONE spoken learner turn. */
export interface PronunciationAssessment {
  /** 0..1 intelligibility score. */
  score: number;
  clarity: PronunciationClarity;
  /** Words a listener would struggle with; lowercase; max 5. */
  unclear_words: string[];
  /** One short sentence, plain English, max 20 words. */
  tip_for_learner: string;
  /** One sentence for the tutor prompt. */
  note_for_tutor: string;
  /** What the tutor asked them to say, if anything. */
  target_phrase: string | null;
  method: PronunciationMethod;
}

/** What the tutor sets when it asks the learner to speak. */
export interface SpeakingPrompt {
  expects_speech: boolean;
  /** Exact short phrase to say aloud (<= 12 words). */
  target_phrase: string | null;
}

/** Clarity buckets from score: >= 0.75 clear; >= 0.5 mostly_clear; else unclear. */
export const clarityFromScore = (score: number): PronunciationClarity =>
  score >= 0.75 ? "clear" : score >= 0.5 ? "mostly_clear" : "unclear";
