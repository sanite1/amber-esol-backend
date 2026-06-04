/**
 * Joi validation for POST /api/org-admin/learners/:id/nudge — Function 12 To-Do 4.
 */

import { Joi, validate } from "express-validation";
import { Types } from "mongoose";

const objectIdRule = (
  value: string,
  helpers: { error: (code: string) => unknown }
) => {
  if (!Types.ObjectId.isValid(value)) return helpers.error("any.invalid");
  return value;
};

const nudgeSchema = {
  params: Joi.object({
    id: Joi.string().custom(objectIdRule, "ObjectId").required(),
  }),
  body: Joi.object({
    custom_message: Joi.string().trim().max(1_000).optional().allow(""),
  }).unknown(false),
};

export const nudgeLearnerValidation = () =>
  validate(nudgeSchema, { context: true }, { abortEarly: false });
