import { Types } from "mongoose";
import { z } from "zod";
import { SchemaType } from "@google-cloud/vertexai";

import { geminiClient, MODEL_NAME } from "../lib/gemini";
import AIUsage from "../models/AIUsage";
import logger from "../config/logger";
import {
  clarityFromScore,
  PronunciationAssessment,
} from "../interfaces/pronunciation.interface";
import { voiceMockEnabled } from "./voice.service";

/**
 * Pronunciation assessment — AI Tutor Build Brief F32.
 *
 * Judges the INTELLIGIBILITY of one spoken learner turn. Accented
 * English is fine; the question is "would a patient listener understand
 * this?", never "does it sound native?".
 *
 * Three paths, in order:
 *   1. mock            — VOICE_MOCK=true (non production): canned result.
 *   2. gemini_audio    — the recording is sent inline to Gemini (Vertex)
 *                        with a JSON response schema. Primary.
 *   3. stt_confidence  — any failure, or no audio: derive a score from
 *                        the recogniser's per-word confidences plus
 *                        token overlap with the target phrase.
 *
 * FAIL SAFE: this function never throws. It returns null only when an
 * assessment is impossible AND there is no fallback data at all (no
 * transcript to work from). No audio is persisted or logged here — only
 * the transcript and the assessment leave this module.
 */

// ── Tunables ───────────────────────────────────────────────────────────

const GEMINI_TIMEOUT_MS = 20_000;
const GEMINI_TEMPERATURE = 0.2;
const GEMINI_MAX_OUTPUT_TOKENS = 512;
const MAX_UNCLEAR_WORDS = 5;
/** Per-word STT confidence below which a word counts as unclear. */
const UNCLEAR_WORD_CONFIDENCE = 0.6;
/** Used when neither per-word nor utterance confidence is available. */
const DEFAULT_CONFIDENCE = 0.6;

// ── Shared helpers (exported for tests) ───────────────────────────────

export const round2 = (n: number): number => Math.round(n * 100) / 100;

export const clamp01 = (n: number): number =>
  Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;

/** Lowercase word tokens, punctuation stripped, empties removed. */
export const tokenize = (text: string | null | undefined): string[] =>
  (text ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}'\s]+/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0);

/**
 * Fraction of the target's tokens that appear in the transcript (0..1).
 * Returns 1 when the target has no tokens (nothing to miss).
 */
export const tokenOverlap = (
  transcript: string,
  target: string | null,
): number => {
  const targetTokens = tokenize(target);
  if (targetTokens.length === 0) return 1;
  const said = new Set(tokenize(transcript));
  const hit = targetTokens.filter((t) => said.has(t)).length;
  return hit / targetTokens.length;
};

// ── Zod schema for Gemini's JSON ──────────────────────────────────────

const geminiAssessmentSchema = z
  .object({
    score: z.number(),
    clarity: z.enum(["clear", "mostly_clear", "unclear"]).optional(),
    unclear_words: z.array(z.string()).default([]),
    tip_for_learner: z.string().default(""),
    note_for_tutor: z.string().default(""),
  })
  .strip();

/** Vertex responseSchema — PronunciationAssessment minus target_phrase/method. */
const GEMINI_RESPONSE_SCHEMA = {
  type: SchemaType.OBJECT,
  properties: {
    score: { type: SchemaType.NUMBER },
    clarity: {
      type: SchemaType.STRING,
      enum: ["clear", "mostly_clear", "unclear"],
    },
    unclear_words: {
      type: SchemaType.ARRAY,
      items: { type: SchemaType.STRING },
    },
    tip_for_learner: { type: SchemaType.STRING },
    note_for_tutor: { type: SchemaType.STRING },
  },
  required: [
    "score",
    "clarity",
    "unclear_words",
    "tip_for_learner",
    "note_for_tutor",
  ],
} as const;

// ── Public types ──────────────────────────────────────────────────────

export interface AssessPronunciationArgs {
  audioBase64: string;
  /** e.g. "audio/webm" */
  mimeType: string;
  transcript: string;
  sttConfidence: number | null;
  words: Array<{ word: string; confidence: number }>;
  targetPhrase: string | null;
  esolLevel: string | null;
  tracking: { sessionId: string; orgId: string | null; learnerId: string };
}

// ── Mock ──────────────────────────────────────────────────────────────

const mockAssessment = (
  targetPhrase: string | null,
): PronunciationAssessment => ({
  score: 0.82,
  clarity: "clear",
  unclear_words: ["appointment"],
  tip_for_learner:
    "Nice and clear. Try stressing the second part of 'appointment'.",
  note_for_tutor: "Spoken turn was clear; 'appointment' slightly unclear.",
  target_phrase: targetPhrase,
  method: "mock",
});

// ── Fallback: STT confidence ──────────────────────────────────────────

const GENERIC_TIPS: Record<PronunciationAssessment["clarity"], string> = {
  clear: "Nice and clear. Keep speaking at that steady pace.",
  mostly_clear:
    "Mostly clear. Try saying each word a little more slowly and fully.",
  unclear:
    "Take your time and say each word slowly; you can try it again any time.",
};

/**
 * Derive an assessment from recogniser confidences. Exported so the
 * scoring maths is unit testable without a Gemini client.
 *
 *   score = target ? 0.5 * avgWordConfidence + 0.5 * tokenOverlap : avgWordConfidence
 *   avgWordConfidence: mean of per-word confidences, else utterance
 *                      confidence, else 0.6
 *   unclear_words: words with confidence < 0.6 plus target tokens missing
 *                  from the transcript (max 5, lowercase, deduped)
 */
export const assessFromSttConfidence = (args: {
  transcript: string;
  sttConfidence: number | null;
  words: Array<{ word: string; confidence: number }>;
  targetPhrase: string | null;
}): PronunciationAssessment => {
  const words = (args.words ?? []).filter(
    (w) =>
      w &&
      typeof w.word === "string" &&
      typeof w.confidence === "number" &&
      Number.isFinite(w.confidence),
  );
  const avgWordConfidence =
    words.length > 0
      ? words.reduce((s, w) => s + clamp01(w.confidence), 0) / words.length
      : typeof args.sttConfidence === "number" &&
          Number.isFinite(args.sttConfidence)
        ? clamp01(args.sttConfidence)
        : DEFAULT_CONFIDENCE;

  const target = args.targetPhrase?.trim() ? args.targetPhrase.trim() : null;
  const rawScore = target
    ? 0.5 * avgWordConfidence + 0.5 * tokenOverlap(args.transcript, target)
    : avgWordConfidence;
  const score = round2(clamp01(rawScore));
  const clarity = clarityFromScore(score);

  const unclear = new Set<string>();
  for (const w of words) {
    if (w.confidence < UNCLEAR_WORD_CONFIDENCE) {
      const t = tokenize(w.word)[0];
      if (t) unclear.add(t);
    }
  }
  if (target) {
    const said = new Set(tokenize(args.transcript));
    for (const t of tokenize(target)) if (!said.has(t)) unclear.add(t);
  }
  const unclear_words = Array.from(unclear).slice(0, MAX_UNCLEAR_WORDS);

  const noteParts = [
    `Spoken turn assessed from recogniser confidence: ${clarity.replace("_", " ")}`,
  ];
  if (unclear_words.length)
    noteParts.push(`less clear: ${unclear_words.join(", ")}`);
  if (target) noteParts.push(`target phrase: "${target}"`);

  return {
    score,
    clarity,
    unclear_words,
    tip_for_learner: GENERIC_TIPS[clarity],
    note_for_tutor: `${noteParts.join("; ")}.`,
    target_phrase: target,
    method: "stt_confidence",
  };
};

// ── Primary: Gemini audio ─────────────────────────────────────────────

const buildPrompt = (args: AssessPronunciationArgs): string => {
  const level = args.esolLevel ? args.esolLevel.toUpperCase() : "unknown";
  const target = args.targetPhrase?.trim()
    ? `The tutor asked them to say: "${args.targetPhrase.trim()}". Compare what you hear to that phrase.`
    : "There was no specific target phrase; judge the utterance on its own.";
  return [
    "You are a kind, experienced ESOL speaking assessor listening to ONE short recording by an adult English learner.",
    `Learner's ESOL level: ${level}.`,
    `A speech recogniser heard: "${args.transcript}".`,
    target,
    "Judge INTELLIGIBILITY only: would a patient native listener understand what was said? Accented English is completely fine and must not lower the score. Do not judge grammar or vocabulary.",
    "Return JSON with:",
    "- score: 0 to 1 (1 = every word easily understood).",
    '- clarity: "clear" (score >= 0.75), "mostly_clear" (>= 0.5) or "unclear".',
    "- unclear_words: up to 5 words a listener would struggle with, lowercase, empty array if none.",
    "- tip_for_learner: ONE kind, plain English sentence (max 20 words) with a concrete pronunciation tip, or praise if clear.",
    "- note_for_tutor: ONE sentence for the tutor summarising how the turn sounded.",
  ].join("\n");
};

const withTimeout = async <T>(promise: Promise<T>, ms: number): Promise<T> => {
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(new Error(`Pronunciation assessment timed out after ${ms} ms`)),
      ms,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const toObjectIdOrNull = (
  v: string | null | undefined,
): Types.ObjectId | null =>
  v && Types.ObjectId.isValid(v) ? new Types.ObjectId(v) : null;

/** Fire-and-forget AIUsage row — same posture as gemini.service. */
const recordUsage = (
  tracking: AssessPronunciationArgs["tracking"],
  usage: { inputTokens: number; outputTokens: number; latencyMs: number },
): void => {
  AIUsage.create({
    org_id: toObjectIdOrNull(tracking.orgId),
    learner_id: toObjectIdOrNull(tracking.learnerId),
    session_id: tracking.sessionId,
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    cached_tokens: 0,
    model_name: MODEL_NAME,
    latency_ms: usage.latencyMs,
    retried: false,
    timestamp: new Date(),
  }).catch((err) =>
    logger.error(
      { err, sessionId: tracking.sessionId },
      "AIUsage ledger write failed for pronunciation assessment — call succeeded, billing row missing",
    ),
  );
};

const assessWithGemini = async (
  args: AssessPronunciationArgs,
): Promise<PronunciationAssessment> => {
  const model = geminiClient.preview.getGenerativeModel({
    model: MODEL_NAME,
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: GEMINI_RESPONSE_SCHEMA as any,
      temperature: GEMINI_TEMPERATURE,
      maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS,
    },
  });

  const startedAt = Date.now();
  const result = await withTimeout(
    model.generateContent({
      contents: [
        {
          role: "user",
          parts: [
            { inlineData: { mimeType: args.mimeType, data: args.audioBase64 } },
            { text: buildPrompt(args) },
          ],
        },
      ],
    }),
    GEMINI_TIMEOUT_MS,
  );
  const latencyMs = Date.now() - startedAt;

  const rawText =
    result.response?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  if (!rawText) throw new Error("Gemini returned an empty body");

  const parsed = geminiAssessmentSchema.parse(JSON.parse(rawText));
  const score = round2(clamp01(parsed.score));
  const unclear_words = Array.from(
    new Set(
      parsed.unclear_words
        .map((w) => tokenize(w)[0] ?? "")
        .filter((w) => w.length > 0),
    ),
  ).slice(0, MAX_UNCLEAR_WORDS);

  const usage = result.response?.usageMetadata;
  recordUsage(args.tracking, {
    inputTokens: usage?.promptTokenCount ?? 0,
    outputTokens: usage?.candidatesTokenCount ?? 0,
    latencyMs,
  });

  const clarity = clarityFromScore(score);
  return {
    score,
    clarity,
    unclear_words,
    tip_for_learner: parsed.tip_for_learner.trim() || GENERIC_TIPS[clarity],
    note_for_tutor:
      parsed.note_for_tutor.trim() ||
      `Spoken turn sounded ${clarity.replace("_", " ")}.`,
    target_phrase: args.targetPhrase?.trim() ? args.targetPhrase.trim() : null,
    method: "gemini_audio",
  };
};

// ── Public entry point ────────────────────────────────────────────────

/**
 * Assess the pronunciation of one spoken turn. Never throws. Returns
 * null only when there is nothing to assess (empty transcript and no
 * audio); otherwise always returns an assessment, falling back to the
 * STT confidence method on any Gemini problem.
 */
export const assessPronunciation = async (
  args: AssessPronunciationArgs,
): Promise<PronunciationAssessment | null> => {
  try {
    const transcript = (args.transcript ?? "").trim();
    const hasAudio =
      typeof args.audioBase64 === "string" && args.audioBase64.length > 0;

    if (!transcript && !hasAudio) return null;

    if (voiceMockEnabled()) {
      return mockAssessment(
        args.targetPhrase?.trim() ? args.targetPhrase.trim() : null,
      );
    }

    if (hasAudio) {
      try {
        return await assessWithGemini({ ...args, transcript });
      } catch (err) {
        logger.warn(
          {
            err: err instanceof Error ? err.message : String(err),
            sessionId: args.tracking.sessionId,
          },
          "Gemini pronunciation assessment failed — falling back to STT confidence",
        );
      }
    }

    if (!transcript) return null;
    return assessFromSttConfidence({
      transcript,
      sttConfidence: args.sttConfidence,
      words: args.words ?? [],
      targetPhrase: args.targetPhrase,
    });
  } catch (err) {
    // Belt and braces: nothing in here may break a learner's turn.
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      "assessPronunciation unexpected failure — returning null",
    );
    return null;
  }
};
