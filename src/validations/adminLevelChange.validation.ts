/**
 * Joi validation for /api/admin/level-change/* — brief Function 11 To-Do 2.
 *
 * The service does its own deeper validation (adjacency, readiness
 * re-check). Joi here catches shape errors at the boundary so the
 * service doesn't have to defend against missing fields.
 */

import { Joi, validate } from "express-validation";
import { Types } from "mongoose";

const objectIdRule = (
  value: string,
  helpers: { error: (code: string) => unknown },
) => {
  if (!Types.ObjectId.isValid(value)) return helpers.error("any.invalid");
  return value;
};

const VALID_LEVELS = ["e1", "e2", "e3", "l1", "l2"] as const;

// ─────────────────────────────────────────────────────────────────────
// POST /api/admin/level-change/confirm
// ─────────────────────────────────────────────────────────────────────

const confirmSchema = {
  body: Joi.object({
    learner_id: Joi.string()
      .custom(objectIdRule, "ObjectId")
      .required()
      .messages({ "any.required": "learner_id is required" }),
    new_level: Joi.string()
      .valid(...VALID_LEVELS)
      .required()
      .messages({
        "any.required": "new_level is required",
        "any.only": "new_level must be one of e1, e2, e3, l1, l2",
      }),
  }).unknown(false),
};

export const confirmLevelChangeValidation = () =>
  validate(confirmSchema, { context: true }, { abortEarly: false });

// ─────────────────────────────────────────────────────────────────────
// POST /api/admin/level-change/reject
// ─────────────────────────────────────────────────────────────────────

const rejectSchema = {
  body: Joi.object({
    learner_id: Joi.string()
      .custom(objectIdRule, "ObjectId")
      .required()
      .messages({ "any.required": "learner_id is required" }),
    reason: Joi.string().trim().min(1).max(4_000).required().messages({
      "any.required": "reason is required",
      "string.empty": "reason must be a non-empty string",
      "string.max": "reason must be 4000 characters or fewer",
    }),
  }).unknown(false),
};

export const rejectLevelChangeValidation = () =>
  validate(rejectSchema, { context: true }, { abortEarly: false });
