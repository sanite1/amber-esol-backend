import { Joi, validate } from "express-validation";
import { Types } from "mongoose";

const objectId = Joi.string()
  .custom((value, helpers) => {
    if (!Types.ObjectId.isValid(value)) {
      return helpers.error("any.invalid");
    }
    return value;
  }, "ObjectId validation")
  .messages({
    "any.invalid": "{{#label}} must be a valid ID",
    "string.base": "{{#label}} must be a string",
    "any.required": "{{#label}} is required",
  });

export const createLevelChangeValidation = () =>
  validate(
    {
      body: Joi.object({
        learnerId: objectId.required(),
        toLevel: Joi.string().trim().required().messages({
          "any.required": "Target level is required",
        }),
        reason: Joi.string().trim().min(5).max(1000).required().messages({
          "string.min": "Reason must be at least 5 characters",
          "any.required": "Reason is required",
        }),
        evidenceSummary: Joi.string().trim().max(2000).optional().allow(""),
        sessionId: objectId.optional(),
        effectiveDate: Joi.string().isoDate().optional(),
      }),
    },
    { context: true },
    { abortEarly: false },
  );

export const listLevelChangesValidation = () =>
  validate(
    {
      query: Joi.object({
        page: Joi.number().integer().min(1).optional(),
        limit: Joi.number().integer().min(1).max(100).optional(),
        learnerId: objectId.optional(),
        orgId: objectId.optional(),
      }),
    },
    { context: true },
    { abortEarly: false },
  );
