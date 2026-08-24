import { createHash } from "crypto";

import logger from "../config/logger";
import { LANGUAGE_META, toSilkLanguage } from "../config/languages";

/**
 * Voice service — AI Tutor Build Brief F28.
 *
 * Two surfaces, both server-side (no audio key ever reaches the client):
 *
 *   synthesizeSpeech  — TTS OUT (universal). Google Cloud Text-to-Speech
 *                       Neural2/WaveNet per language. Recurring phrases
 *                       (Beat-1 primers, completion lines) are cached in
 *                       memory so we don't re-bill identical synthesis.
 *
 *   transcribeSpeech  — STT IN (opt-in, default OFF). Google Cloud
 *                       Speech-to-Text, forgiving config — never a
 *                       pass/fail gate, just a convenience over typing.
 *                       Tap-to-type is always the fallback on the client.
 *
 * GRACEFUL DEGRADATION (the safeguarding-crypto posture): voice is an
 * enhancement, never load-bearing. When a feature is disabled by env,
 * the language has no voice locale, or the GCP client can't initialise
 * (no creds), the function returns null and the caller serves text only.
 * It must NEVER throw into the turn path.
 *
 * DATA RESIDENCY [UNVERIFIED — confirm before production]: the EU
 * commitment requires audio to stay in-region. We target the EU
 * endpoints by default (`VOICE_LOCATION`, default europe-west4) but the
 * funding/governance owner must confirm the regional endpoints + the
 * data-processing terms satisfy the EU commitment before voice ships.
 */

// ── Feature flags + region ─────────────────────────────────────────────

const ttsEnabled = (): boolean => process.env.VOICE_TTS_ENABLED === "true";
// STT defaults OFF — the brief is explicit it's opt-in.
const sttEnabled = (): boolean => process.env.VOICE_STT_ENABLED === "true";

/**
 * F32 dev mock. When VOICE_MOCK=true (and we are NOT in production)
 * transcribeSpeech returns a canned transcript without touching Google,
 * so the spoken-turn flow can be rehearsed + tested offline. Still
 * requires sttEnabled() — the mock never turns the feature on by itself.
 */
export const voiceMockEnabled = (): boolean =>
  process.env.VOICE_MOCK === "true" && process.env.NODE_ENV !== "production";

const MOCK_TRANSCRIPT =
  "I would like to book an appointment with the doctor please";
const MOCK_WORD_CONFIDENCES: Array<{ word: string; confidence: number }> = [
  { word: "I", confidence: 0.95 },
  { word: "would", confidence: 0.92 },
  { word: "like", confidence: 0.94 },
  { word: "to", confidence: 0.9 },
  { word: "book", confidence: 0.88 },
  { word: "an", confidence: 0.85 },
  { word: "appointment", confidence: 0.58 },
  { word: "with", confidence: 0.9 },
  { word: "the", confidence: 0.91 },
  { word: "doctor", confidence: 0.87 },
  { word: "please", confidence: 0.9 },
];

const VOICE_LOCATION = process.env.VOICE_LOCATION || "europe-west4";
// EU MULTIREGION endpoints (data residency). Overridable per region.
// NOTE: the v1 Speech client only supports the multiregion hosts
// (eu-speech / us-speech). Region-specific hosts like
// europe-west4-speech.googleapis.com belong to the v2 API and answer
// v1 calls with UNIMPLEMENTED — verified against the live service.
const TTS_ENDPOINT =
  process.env.VOICE_TTS_ENDPOINT || "eu-texttospeech.googleapis.com";
const STT_ENDPOINT =
  process.env.VOICE_STT_ENDPOINT || "eu-speech.googleapis.com";

// ── Voice selection per locale ─────────────────────────────────────────

/**
 * Preferred Neural2/WaveNet voice per MVP locale. Falls back to letting
 * Google pick by languageCode when a locale has no premium voice (e.g.
 * Cantonese yue-HK currently ships Standard voices only).
 */
const PREFERRED_VOICE: Record<string, string | null> = {
  "en-GB": "en-GB-Neural2-A",
  "ar-XA": "ar-XA-Wavenet-A",
  "tr-TR": "tr-TR-Wavenet-A",
  "yue-HK": null, // Standard only — let Google choose by languageCode.
};

/** Resolve the TTS/STT locale for a learner language, or null. */
export const voiceLocaleFor = (language: string): string | null => {
  const code = toSilkLanguage(language);
  return LANGUAGE_META[code]?.voiceLocale ?? null;
};

// ── Lazy GCP clients ───────────────────────────────────────────────────
//
// Instantiated on first use (not at import) so a deploy with voice
// disabled never pays the client init / credential lookup. `null` once
// we know init failed, so we don't retry every turn.

let ttsClient: any;
let ttsInitFailed = false;
let sttClient: any;
let sttInitFailed = false;

const getTtsClient = (): any => {
  if (ttsClient || ttsInitFailed) return ttsClient ?? null;
  try {
    // Lazy require so the dependency is only loaded when voice is on.
    const { TextToSpeechClient } = require("@google-cloud/text-to-speech");
    ttsClient = new TextToSpeechClient({ apiEndpoint: TTS_ENDPOINT });
    return ttsClient;
  } catch (err) {
    ttsInitFailed = true;
    logger.warn(
      { err: (err as Error).message },
      "TTS client init failed — voice synthesis unavailable (text-only fallback)",
    );
    return null;
  }
};

const getSttClient = (): any => {
  if (sttClient || sttInitFailed) return sttClient ?? null;
  try {
    const { SpeechClient } = require("@google-cloud/speech");
    sttClient = new SpeechClient({ apiEndpoint: STT_ENDPOINT });
    return sttClient;
  } catch (err) {
    sttInitFailed = true;
    logger.warn(
      { err: (err as Error).message },
      "STT client init failed — speech input unavailable (tap-to-type fallback)",
    );
    return null;
  }
};

// ── Recurring-phrase cache (TTS) ───────────────────────────────────────
//
// Bounded in-memory LRU-ish cache. Beat-1 primers and completion lines
// repeat across learners; caching the synthesised MP3 avoids re-billing
// identical (text, locale) pairs. Cleared on process restart — fine, it
// re-warms quickly.

const PHRASE_CACHE_MAX = 500;
const phraseCache = new Map<string, string>(); // key → base64 mp3

const cacheKey = (text: string, locale: string, voice: string): string =>
  createHash("sha256").update(`${locale}|${voice}|${text}`).digest("hex");

const cacheGet = (key: string): string | null => {
  const hit = phraseCache.get(key);
  if (hit === undefined) return null;
  // Touch for recency: re-insert so it moves to the end.
  phraseCache.delete(key);
  phraseCache.set(key, hit);
  return hit;
};

const cacheSet = (key: string, value: string): void => {
  if (phraseCache.size >= PHRASE_CACHE_MAX) {
    const oldest = phraseCache.keys().next().value;
    if (oldest !== undefined) phraseCache.delete(oldest);
  }
  phraseCache.set(key, value);
};

export const __resetVoiceCacheForTests = (): void => phraseCache.clear();

// ── Public: TTS ────────────────────────────────────────────────────────

export interface SynthesisResult {
  audioBase64: string;
  contentType: "audio/mpeg";
  cached: boolean;
}

/**
 * Synthesise speech for a learner-facing line. Returns null (caller
 * serves text only) when TTS is disabled, the language has no voice, the
 * text is empty, or synthesis fails.
 */
export const synthesizeSpeech = async (
  text: string,
  language: string,
): Promise<SynthesisResult | null> => {
  if (!ttsEnabled()) return null;
  const trimmed = (text ?? "").trim();
  if (!trimmed) return null;

  const locale = voiceLocaleFor(language);
  if (!locale) return null; // deferred language — no voice contract yet

  const preferred = PREFERRED_VOICE[locale] ?? null;
  const key = cacheKey(trimmed, locale, preferred ?? "auto");
  const cached = cacheGet(key);
  if (cached)
    return { audioBase64: cached, contentType: "audio/mpeg", cached: true };

  const client = getTtsClient();
  if (!client) return null;

  try {
    const [response] = await client.synthesizeSpeech({
      input: { text: trimmed },
      voice: {
        languageCode: locale,
        ...(preferred ? { name: preferred } : {}),
      },
      audioConfig: { audioEncoding: "MP3" },
    });
    const content = response?.audioContent;
    if (!content) return null;
    const audioBase64 = Buffer.isBuffer(content)
      ? content.toString("base64")
      : Buffer.from(content).toString("base64");
    cacheSet(key, audioBase64);
    return { audioBase64, contentType: "audio/mpeg", cached: false };
  } catch (err) {
    logger.error(
      { err: (err as Error).message, locale },
      "TTS synthesis failed — text-only fallback",
    );
    return null;
  }
};

// ── Public: STT ──────────────────────────────────────────────────────────

export interface TranscriptionWord {
  word: string;
  confidence: number;
}

export interface TranscriptionResult {
  transcript: string;
  /** Utterance-level recogniser confidence (0..1), null when Google
   *  did not report one. F32 — feeds the pronunciation fallback. */
  confidence: number | null;
  /** Per-word confidences (enableWordConfidence). Empty when absent. */
  words: TranscriptionWord[];
}

const clamp01 = (n: unknown): number | null => {
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  return Math.min(1, Math.max(0, n));
};

/**
 * Transcribe a short learner utterance. Opt-in (VOICE_STT_ENABLED) and
 * forgiving — returns null (caller falls back to tap-to-type) on any
 * problem rather than surfacing an error. NEVER a pass/fail signal.
 *
 * `audioBase64` is the raw recording; `encoding`/`sampleRateHertz` come
 * from the client recorder (WEBM_OPUS at 48000 is the browser default).
 *
 * F32: also returns the recogniser's confidence + per-word confidences
 * (enableWordConfidence) so the pronunciation assessor has a fallback
 * signal when Gemini audio assessment is unavailable. Existing callers
 * that only read `transcript` keep working unchanged.
 */
export const transcribeSpeech = async (
  audioBase64: string,
  language: string,
  opts?: { encoding?: string; sampleRateHertz?: number },
): Promise<TranscriptionResult | null> => {
  if (!sttEnabled()) return null;
  if (!audioBase64) return null;

  // Dev mock — canned transcript, no Google call, no client init.
  if (voiceMockEnabled()) {
    return {
      transcript: MOCK_TRANSCRIPT,
      confidence: 0.86,
      words: MOCK_WORD_CONFIDENCES.map((w) => ({ ...w })),
    };
  }

  const locale = voiceLocaleFor(language);
  if (!locale) return null;

  const client = getSttClient();
  if (!client) return null;

  try {
    const [response] = await client.recognize({
      audio: { content: audioBase64 },
      config: {
        // Forgiving defaults — the learner is mid-acquisition, not
        // dictating. Auto-punctuation off (it guesses badly on L2
        // speech); the transcript feeds the same text turn path.
        languageCode: locale,
        encoding: opts?.encoding ?? "WEBM_OPUS",
        sampleRateHertz: opts?.sampleRateHertz ?? 48000,
        enableAutomaticPunctuation: false,
        // F32 — per-word confidence feeds the pronunciation fallback.
        enableWordConfidence: true,
        // Chirp 2 is the target model (best L2/accented coverage);
        // configurable so a deploy can pin the exact model name.
        model: process.env.VOICE_STT_MODEL || "default",
      },
    });
    const results: any[] = response?.results ?? [];
    const transcript = results
      .map((r: any) => r.alternatives?.[0]?.transcript ?? "")
      .join(" ")
      .trim();
    if (!transcript) return null;

    // Utterance confidence: mean of the per-result alternative
    // confidences that Google reported (null if none did).
    const altConfs = results
      .map((r: any) => clamp01(r.alternatives?.[0]?.confidence))
      .filter((c): c is number => c !== null);
    const confidence =
      altConfs.length > 0
        ? altConfs.reduce((s, c) => s + c, 0) / altConfs.length
        : null;

    const words: TranscriptionWord[] = [];
    for (const r of results) {
      for (const w of r.alternatives?.[0]?.words ?? []) {
        const word = typeof w?.word === "string" ? w.word.trim() : "";
        const conf = clamp01(w?.confidence);
        if (word && conf !== null) words.push({ word, confidence: conf });
      }
    }

    return { transcript, confidence, words };
  } catch (err) {
    logger.error(
      { err: (err as Error).message, locale },
      "STT transcription failed — tap-to-type fallback",
    );
    return null;
  }
};

/** Capability flags for the client (so the UI shows the right controls). */
export const voiceCapabilities = () => ({
  tts: ttsEnabled(),
  stt: sttEnabled(),
  location: VOICE_LOCATION,
});
