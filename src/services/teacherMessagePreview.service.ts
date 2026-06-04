/**
 * Teacher message translation preview — Final Addendum §11.
 *
 *   POST /api/teacher/messages/preview-translation
 *
 * Powers the in-modal live translation preview. The teacher types
 * (debounced ~800ms client-side); we call Gemini with the same
 * prompt the real send uses and return the translated string
 * WITHOUT persisting anything.
 *
 * Why a separate endpoint vs. dry-running the send route?
 * =======================================================
 *
 * The send route writes a TeacherMessage row, an AuditLog row, and
 * (often) a notification job. A "preview" that needed to inhibit
 * each of those side effects would smear conditional logic across
 * the durable path and risk an accidental write. The preview lives
 * on its own with zero state mutation — the only side effect is
 * the Gemini call itself, which is read-only externally.
 *
 * Why no per-learner gate?
 * ========================
 *
 * The preview never references a learner id — it takes the message
 * text + target language directly. A teacher composing for one
 * learner can preview a translation without leaking the learner
 * id to the translation provider, and a teacher who isn't yet on
 * a learner-detail page (e.g. testing a template) can still preview.
 *
 * The auth chain (teacher role + ESOL approval + DBS cleared) is
 * the gate that matters here; the preview can produce any
 * arbitrary English-to-L1 translation, which is no more
 * disclosure-y than the existing AI tutor flow.
 *
 * Future hardening
 * ================
 *
 * No per-route rate limiter today — the debounced client + the
 * tight teacher-role gate (small audited set of users) keeps
 * pressure manageable. If this becomes the costliest Gemini call
 * pattern on the platform, wrap with a per-teacher rate limiter
 * before scaling teacher seats. Tracked as a P3 backlog item.
 */

import ApiError from "../errors/apiError";
import ApiResponse from "../errors/apiResponse";
import logger from "../config/logger";
import { translateTeacherMessage } from "./teacherMessageTranslate.service";

// ─────────────────────────────────────────────────────────────────────
// Public shapes
// ─────────────────────────────────────────────────────────────────────

export interface PreviewTranslationBody {
  message_text: string;
  target_language: string;
}

export interface PreviewTranslationInput {
  teacher_id: string;
  body: PreviewTranslationBody;
}

export interface PreviewTranslationResult {
  translated: string;
  target_language: string;
  /** Character count of the translated output — UI uses this for a "fits in 600" indicator. */
  translated_length: number;
}

// ─────────────────────────────────────────────────────────────────────
// Top-level entry
// ─────────────────────────────────────────────────────────────────────

export const previewTeacherMessageTranslationService = async (
  input: PreviewTranslationInput,
): Promise<ApiResponse> => {
  // ── Input validation (defensive — Joi has run) ────────────────
  const body = input.body;
  const messageText =
    typeof body?.message_text === "string" ? body.message_text.trim() : "";
  const targetLanguage =
    typeof body?.target_language === "string"
      ? body.target_language.trim()
      : "";

  if (messageText.length === 0) {
    throw new ApiError(400, "message_text is required");
  }
  if (messageText.length > 300) {
    throw new ApiError(
      400,
      "message_text must be 300 characters or fewer",
    );
  }
  if (targetLanguage.length === 0) {
    throw new ApiError(400, "target_language is required");
  }
  // Refuse English-to-English up-front rather than burning a Gemini
  // call. The frontend already gates this (toggle hidden when the
  // learner's L1 is English) but defence-in-depth is cheap.
  if (targetLanguage.toLowerCase() === "english") {
    throw new ApiError(
      400,
      "target_language must not be English — preview is for non-English translations only",
    );
  }

  // ── Translate ────────────────────────────────────────────────
  let translated: string;
  try {
    translated = await translateTeacherMessage(messageText, targetLanguage);
  } catch (err) {
    logger.error(
      {
        err: (err as Error).message,
        teacher_id: input.teacher_id,
        target_language: targetLanguage,
        text_length: messageText.length,
      },
      "previewTeacherMessageTranslation: Gemini failed",
    );
    // Same 502 the send path uses. The frontend treats either
    // path's 502 the same way — surfaces a "preview unavailable"
    // banner while keeping the composer open so the teacher can
    // still send untranslated.
    throw new ApiError(
      502,
      "Translation preview unavailable. Try again in a moment.",
    );
  }

  const result: PreviewTranslationResult = {
    translated,
    target_language: targetLanguage,
    translated_length: translated.length,
  };
  return new ApiResponse(200, "Translation preview", result);
};
