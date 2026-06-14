/**
 * Joi validation for the teacher RARPA Stage 5 sign-off endpoint —
 * Final Addendum §9, Todo 22.7.
 *
 *   POST /api/teacher/learners/:id/rarpa-signoff
 *
 * Body shape only. Semantic checks live in the service:
 *   - learner-assignment gate
 *   - stage5_review_id belongs to this learner
 *   - learner_self_assessment + ai_tutor_summary both populated
 *   - single-shot (teacher_signed_off_at must be null)
 *
 * Field caps
 * ==========
 *
 * `TeacherReview.notes` has `maxlength: 500` at the schema layer.
 * The service persists `teacher_assessment + " | " + next_steps_recommendation`
 * into that field, so each half is capped at 240 chars here
 * (240 + 3 separator + 240 = 483, comfortably inside 500). Tightening
 * at the Joi layer means the teacher sees a clear "too long" message
 * up-front rather than a Mongoose ValidationError surfaced as a 500.
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
    stage5_review_id: Joi.string()
      .pattern(/^[a-fA-F0-9]{24}$/)
      .required()
      .messages({
        "string.pattern.base": "stage5_review_id must be a 24-char ObjectId",
      }),
    teacher_assessment: Joi.string()
      .trim()
      .min(1)
      .max(240)
      .required()
      .messages({
        "string.empty": "teacher_assessment is required",
        "string.max": "teacher_assessment must be 240 characters or fewer",
      }),
    next_steps_recommendation: Joi.string()
      .trim()
      .min(1)
      .max(240)
      .required()
      .messages({
        "string.empty": "next_steps_recommendation is required",
        "string.max":
          "next_steps_recommendation must be 240 characters or fewer",
      }),
  }).unknown(false),
};

export const signOffStage5ReviewValidation = () =>
  validate(schema, { context: true }, { abortEarly: false });
