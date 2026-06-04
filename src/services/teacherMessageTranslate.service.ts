/**
 * Shared Gemini translation helper for teacher messages —
 * Final Addendum §11.
 *
 * Two call sites:
 *   - `sendTeacherMessageService` (POST /teacher/learners/:id/message)
 *     — translates and persists.
 *   - `previewTeacherMessageTranslationService`
 *     (POST /teacher/messages/preview-translation) — translates and
 *     returns without persisting; powers the in-modal live preview.
 *
 * Both paths MUST produce identical translations for the same
 * input. Sharing one function (rather than copy-pasting the
 * prompt) guarantees that — a teacher's preview matches what
 * the learner actually receives, byte for byte.
 *
 * Prompt design notes
 * ===================
 *
 *   - "Translate verbatim" — preserve tutor intent + tone; no
 *     paraphrase, no commentary, no greetings/sign-offs that
 *     weren't in the original.
 *   - "Literal accuracy over fluency" when there's no idiomatic
 *     equivalent — tutor messages must MEAN the same thing in
 *     either language for the audit story to hold up.
 *   - `responseMimeType: "application/json"` per the gemini.ts
 *     contract (set per-request, never client-level).
 *   - Temperature 0 — determinism. Same input → same translation
 *     across preview + send.
 *   - 800 output tokens: a 300-char input expanded ~2× plus JSON
 *     wrap fits comfortably.
 */

import { geminiClient, MODEL_NAME } from "../lib/gemini";

const SYSTEM_PROMPT =
  "You translate short tutor messages from English into the target language. " +
  "Translate verbatim — preserve the tutor's intent and tone exactly. " +
  "Do NOT add commentary, do NOT paraphrase, do NOT add greetings or sign-offs " +
  "that weren't in the original. " +
  "If a phrase has no idiomatic equivalent, prefer literal accuracy over fluency. " +
  'Respond with valid JSON of shape `{ "translated": "<text>" }` and nothing else.';

/**
 * Translate `text` (English) to `targetLanguage` using Gemini.
 * Returns the translated string on success; throws on parse / API
 * failure. Callers map the throw to the right HTTP status:
 *   - send path: 502 ("translation service unavailable")
 *   - preview path: 502 with the same message — the UI distinguishes
 *     "couldn't translate" from "translation = X" via the error
 *     surface, not the status code.
 */
export const translateTeacherMessage = async (
  text: string,
  targetLanguage: string,
): Promise<string> => {
  const model = geminiClient.preview.getGenerativeModel({
    model: MODEL_NAME,
    systemInstruction: {
      role: "system",
      parts: [{ text: SYSTEM_PROMPT }],
    },
    generationConfig: {
      responseMimeType: "application/json",
      temperature: 0,
      maxOutputTokens: 800,
    },
  });

  const userPrompt =
    `Target language: ${targetLanguage}\n` +
    `Source text (English):\n${text}`;

  const result = await model.generateContent({
    contents: [{ role: "user", parts: [{ text: userPrompt }] }],
  });
  const raw =
    result.response?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  if (!raw) {
    throw new Error("Gemini returned an empty response");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Gemini returned non-JSON despite responseMimeType: ${(err as Error).message}`,
    );
  }
  const translated = (parsed as { translated?: unknown }).translated;
  if (typeof translated !== "string" || translated.trim().length === 0) {
    throw new Error("Gemini response missing `translated` string field");
  }
  return translated.trim();
};

export const __internals__ = {
  SYSTEM_PROMPT,
};
