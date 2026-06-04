/**
 * Joi validation for the Stage 5 org-admin confirmation endpoint —
 * brief Function 17.
 *
 * Shape gate only; the service does the semantic checks (org scope,
 * learner+AI parts ready, single-shot guard).
 */

import { Joi, validate } from "express-validation";

const VALID_LEVELS = ["e1", "e2", "e3", "l1", "l2"] as const;

const schema = {
  params: Joi.object({
    reviewId: Joi.string()
      .pattern(/^[a-fA-F0-9]{24}$/)
      .required(),
  }),
  body: Joi.object({
    next_steps: Joi.string().trim().min(1).max(2000).required().messages({
      "any.required": "next_steps is required",
      "string.empty": "next_steps cannot be empty",
      "string.max": "next_steps must be 2000 characters or fewer",
    }),
    advance_to_level: Joi.string()
      .valid(...VALID_LEVELS)
      .optional()
      .messages({
        "any.only": "advance_to_level must be one of e1, e2, e3, l1, l2",
      }),
  }).unknown(false),
};

export const confirmStage5ReviewValidation = () =>
  validate(schema, { context: true }, { abortEarly: false });
