/**
 * Separate, tightly scoped recast call — Silk brief section 3 PROPOSAL.
 *
 * The tutor turn asks one model call to hold a conversation, keep an
 * L1 ratio, run a roleplay AND produce a grammatical recast. In the
 * live test the recast was wrong in 3 of 4 runs ("I have back pain for
 * two weeks"). This module asks for the corrected sentence on its own,
 * at temperature 0, with a strict schema, and validates the answer
 * before anything downstream may use it.
 *
 * Behind RECAST_MODE:
 *   inline   (default) unchanged: the recast lives inside the reply
 *   separate run this call alongside the turn; the result is stored
 *            on the turn as `recast` and traced, so the specialist can
 *            mark it against the inline one before it drives the UI
 */

import { SchemaType } from "@google-cloud/vertexai";
import { generateTurn, type GenerateTurnTracking } from "./gemini.service";
import type { EsolLevel } from "../interfaces/placementQuestion.interface";
import logger from "../config/logger";
import { englishShare } from "../eval/tutorEvalChecks";

export type RecastMode = "inline" | "separate";
export const recastMode = (): RecastMode =>
  (process.env.RECAST_MODE ?? "inline").toLowerCase() === "separate"
    ? "separate"
    : "inline";

export interface RecastResult {
  has_error: boolean;
  /** The learner's sentence with the smallest change that makes it
   *  natural British English. Equal to the input when has_error=false. */
  corrected: string;
  /** Short label, e.g. "present perfect for duration", or null. */
  error_type: string | null;
  /** One line the tutor could say, in English. */
  note_en: string | null;
}

const RECAST_SCHEMA = {
  type: SchemaType.OBJECT,
  properties: {
    has_error: { type: SchemaType.BOOLEAN },
    corrected: { type: SchemaType.STRING },
    error_type: { type: SchemaType.STRING, nullable: true },
    note_en: { type: SchemaType.STRING, nullable: true },
  },
  required: ["has_error", "corrected"],
};

const LEVEL_NOTE: Record<EsolLevel, string> = {
  e1: "Entry 1 (CEFR A1): only fix errors that block meaning; keep present simple.",
  e2: "Entry 2 (CEFR A2): fix errors that block meaning or basic tense.",
  e3: "Entry 3 (CEFR B1): fix tense, aspect and preposition errors.",
  l1: "Level 1 (CEFR B1+): fix tense, aspect, articles, word order.",
  l2: "Level 2 (CEFR B2): fix anything a fluent speaker would notice.",
};

const SYSTEM = `You are a DELTA qualified ESOL teacher checking ONE learner sentence.
Return JSON only.
Rules:
1. If the sentence is acceptable British English for the level, set has_error=false and return it unchanged in "corrected".
2. Otherwise set has_error=true and put in "corrected" the SMALLEST change that makes it natural British English. Keep the learner's meaning and words wherever possible. Do not add information.
3. The corrected sentence must itself be grammatically correct. Check tense and aspect carefully: a state that started in the past and continues now takes the present perfect ("I have had back pain for two weeks", not "I have back pain for two weeks").
4. error_type: a short label, or null. note_en: one short sentence a tutor could say, or null.`;

const clean = (s: string) => s.replace(/\s+/g, " ").trim();

/** Latin script alone does not prove English (Turkish is Latin too):
 *  require at least one common English function word as well. */
const ENGLISH_FUNCTION_WORDS =
  /\b(the|a|an|i|you|he|she|we|they|it|is|are|was|were|have|has|had|do|does|did|to|for|on|in|at|of|with|and|or|but|my|your|please|would|could|can|will|not|this|that)\b/i;
const looksEnglish = (s: string): boolean =>
  englishShare(s) >= 0.6 && ENGLISH_FUNCTION_WORDS.test(s);

/** Reject answers that are not a minimal English recast. Pure. */
export const validateRecast = (
  learnerSentence: string,
  r: Partial<RecastResult> | null | undefined,
): RecastResult | null => {
  if (!r || typeof r.has_error !== "boolean" || typeof r.corrected !== "string")
    return null;
  const corrected = clean(r.corrected);
  const original = clean(learnerSentence);
  if (!corrected) return null;
  if (!looksEnglish(corrected)) return null; // must be English
  if (corrected.length > Math.max(40, original.length * 2)) return null; // not a rewrite
  if (r.has_error && corrected.toLowerCase() === original.toLowerCase())
    return null; // claims an error but changed nothing
  if (!r.has_error && corrected.toLowerCase() !== original.toLowerCase())
    return { ...r, has_error: false, corrected: original } as RecastResult;
  return {
    has_error: r.has_error,
    corrected,
    error_type: typeof r.error_type === "string" ? r.error_type : null,
    note_en: typeof r.note_en === "string" ? r.note_en : null,
  };
};

export const proposeRecast = async (args: {
  learnerSentence: string;
  level: EsolLevel;
  tracking: GenerateTurnTracking;
}): Promise<RecastResult | null> => {
  const sentence = clean(args.learnerSentence);
  if (!sentence || !/[A-Za-z]/.test(sentence)) return null; // nothing English to recast
  try {
    const result = await generateTurn<Partial<RecastResult>>({
      systemPrompt: `${SYSTEM}\nLevel: ${LEVEL_NOTE[args.level] ?? LEVEL_NOTE.e2}`,
      conversationHistory: [],
      userMessage: sentence,
      responseSchema: RECAST_SCHEMA as unknown as Record<string, unknown>,
      temperature: 0,
      maxOutputTokens: 512,
      thinkingBudget: 128,
      timeoutMs: 8_000,
      tracking: args.tracking,
      traceSource: "recast",
    });
    return validateRecast(sentence, result.parsed);
  } catch (err) {
    logger.warn(
      { err, session_id: args.tracking.sessionId },
      "separate recast call failed — turn continues without it",
    );
    return null;
  }
};
