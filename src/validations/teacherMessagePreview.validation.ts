/**
 * Joi validation for the teacher-message translation preview endpoint —
 * Final Addendum §11.
 *
 *   POST /api/teacher/messages/preview-translation
 *
 * Body shape only. Semantic checks (English-to-English refusal,
 * Gemini availability) live in the service.
 */

import { Joi, validate } from "express-validation";

const schema = {
  body: Joi.object({
    message_text: Joi.string().trim().min(1).max(300).required().messages({
      "string.empty": "message_text is required",
      "string.max": "message_text must be 300 characters or fewer",
    }),
    // Loose-typed string so the frontend can pass whatever
    // `User.l1Language` carries without us re-inventing an ISO
    // mapping here. Phase 19's language helper will tighten this
    // to a controlled vocabulary.
    target_language: Joi.string().trim().min(2).max(40).required().messages({
      "string.empty": "target_language is required",
    }),
  }).unknown(false),
};

export const previewTranslationValidation = () =>
  validate(schema, { context: true }, { abortEarly: false });
