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

export const createSessionValidation = () =>
  validate(
    {
      body: Joi.object({
        learnerId: objectId.required(),
        teacherId: objectId.required(),
        bookingId: objectId.optional(),
        sessionMode: Joi.string()
          .valid("BRIDGE", "ANCHOR", "IMMERSION")
          .optional(),
        topic: Joi.string().trim().max(200).optional().allow(""),
      }),
    },
    { context: true },
    { abortEarly: false }
  );

export const listSessionsValidation = () =>
  validate(
    {
      query: Joi.object({
        page: Joi.number().integer().min(1).optional(),
        limit: Joi.number().integer().min(1).max(100).optional(),
        learnerId: objectId.optional(),
        teacherId: objectId.optional(),
      }),
    },
    { context: true },
    { abortEarly: false }
  );

export const sessionIdParamValidation = () =>
  validate(
    { params: Joi.object({ sessionId: objectId.required() }) },
    { context: true },
    { abortEarly: false }
  );

export const submitTurnValidation = () =>
  validate(
    {
      params: Joi.object({ sessionId: objectId.required() }),
      body: Joi.object({
        input: Joi.string().trim().min(1).max(2000).required().messages({
          "string.min": "Input must not be empty",
          "string.max": "Input must be 2000 characters or fewer",
          "any.required": "Input is required",
        }),
      }),
    },
    { context: true },
    { abortEarly: false }
  );

// joinSessionValidation removed in pivot
