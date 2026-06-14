/**
 * Joi validation for the teacher messaging endpoint —
 * Final Addendum §11, Phase 24.
 *
 *   POST /api/teacher/learners/:id/message
 *
 * Body shape only. Semantic checks (learner-assignment gate,
 * translation success, learner-email placeholder check) live
 * in the service.
 *
 * The 300-char ceiling is the BRIEF's input limit on the
 * teacher's original English text — long-form coaching belongs
 * in a contact_session, not a one-way nudge. The schema's
 * `message_text` field has a higher (600) cap so a translation
 * can use the headroom without re-validation; the input itself
 * stays at 300.
 */

import { Joi, validate } from "express-validation";

const schema = {
  params: Joi.object({
    id: Joi.string()
      .pattern(/^[a-fA-F0-9]{24}$/)
      .required()
      .messages({
        "string.pattern.base": "learner id must be a 24-char ObjectId",
      }),
  }),
  body: Joi.object({
    message_text: Joi.string().trim().min(1).max(300).required().messages({
      "string.empty": "message_text is required",
      "string.min": "message_text must contain at least one character",
      "string.max":
        "message_text must be 300 characters or fewer (long-form notes belong in a contact session)",
    }),
    translate_to_l1: Joi.boolean().required().messages({
      "any.required":
        "translate_to_l1 is required — choose true (auto-translate to learner's L1) or false (send as English)",
    }),
    // Optional — defaults to "manual" in the service. The enum
    // mirrors the TeacherMessage schema's `trigger` enum so a
    // mis-typed value is rejected up-front rather than at write
    // time.
    trigger: Joi.string()
      .valid("manual", "priority_queue", "re_engagement_cron")
      .optional(),
  }).unknown(false),
};

export const sendTeacherMessageValidation = () =>
  validate(schema, { context: true }, { abortEarly: false });
