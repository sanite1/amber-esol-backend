/**
 * Joi validation for the Stage 5 learner self-assessment endpoint —
 * brief Function 17.
 *
 * Joi handles the structural shape; the service does the semantic
 * checks (objective ids match the snapshot, single-shot guard,
 * caller-is-the-learner). Whitelist with `.unknown(false)` so a
 * future field addition has to be opted in explicitly.
 */

import { Joi, validate } from "express-validation";

const CONFIDENCE = ["low", "medium", "high"] as const;
const OBJECTIVE = ["struggling", "progressing", "confident"] as const;
const NEXT_STEPS = [
  "more_practice",
  "advance_level",
  "specific_focus",
  "unsure",
] as const;

const schema = {
  params: Joi.object({
    reviewId: Joi.string()
      .pattern(/^[a-fA-F0-9]{24}$/)
      .required(),
  }),
  body: Joi.object({
    confidence_rating: Joi.string()
      .valid(...CONFIDENCE)
      .required(),
    objective_ratings: Joi.object()
      // Keys are stage3-objective UUIDs supplied by the frontend.
      // Each value MUST be one of the three rating strings.
      .pattern(/.*/, Joi.string().valid(...OBJECTIVE))
      .required(),
    next_steps_preference: Joi.string()
      .valid(...NEXT_STEPS)
      .required(),
  }).unknown(false),
};

export const submitStage5SelfAssessmentValidation = () =>
  validate(schema, { context: true }, { abortEarly: false });
