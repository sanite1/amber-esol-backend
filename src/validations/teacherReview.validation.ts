/**
 * Joi validation for the teacher review-log endpoint —
 * Final Addendum §9, Todo 22.5.
 *
 *   POST /api/teacher/learners/:id/review
 *
 * Body shape gate. Semantic checks (learner exists, assigned to
 * this teacher) live in the service.
 *
 * The `review_type` enum mirrors the TeacherReview model's enum;
 * a drift between the two would let a bad value through Joi and
 * crash at Mongoose's schema validation. They're declared as
 * literal arrays in both places (no shared import) because the
 * model schema is itself authoritative — duplication is worth the
 * de-coupling, and a CI grep across both files catches drift in
 * code review.
 */

import { Joi, validate } from "express-validation";

const REVIEW_TYPES = [
  "async_review",
  "contact_session",
  "pathway_adjustment",
  "rarpa_signoff",
] as const;

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
    review_type: Joi.string()
      .valid(...REVIEW_TYPES)
      .required(),
    // 5 min minimum guards against a fat-finger "0.5" that would
    // make the GLH running total meaningless. 240 mins (4h) ceiling
    // catches a stuck-clock case — a real teacher review longer
    // than 4 hours is almost certainly two reviews mis-logged as
    // one and worth re-entering separately.
    duration_mins: Joi.number().integer().min(5).max(240).required(),
    notes: Joi.string().trim().allow("").max(500).optional(),
    ai_recommendation_acted_on: Joi.boolean().required(),
  }).unknown(false),
};

export const logTeacherReviewValidation = () =>
  validate(schema, { context: true }, { abortEarly: false });
