/**
 * Joi validation for GET /api/org-admin/learners/:id — Function 12 To-Do 2.
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

const learnerDetailSchema = {
  params: Joi.object({
    id: Joi.string().custom(objectIdRule, "ObjectId").required(),
  }),
  query: Joi.object({
    sessions_page: Joi.string().pattern(/^[1-9]\d*$/).optional(),
    sessions_limit: Joi.string().pattern(/^[1-9]\d*$/).optional(),
    audit_page: Joi.string().pattern(/^[1-9]\d*$/).optional(),
    audit_limit: Joi.string().pattern(/^[1-9]\d*$/).optional(),
  })
    .unknown(false)
    .messages({
      "object.unknown": 'Query parameter "{#label}" is not supported',
    }),
};

export const learnerDetailValidation = () =>
  validate(learnerDetailSchema, { context: true }, { abortEarly: false });
