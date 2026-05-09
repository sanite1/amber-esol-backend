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

export const listVocabValidation = () =>
  validate(
    {
      query: Joi.object({
        page: Joi.number().integer().min(1).optional(),
        limit: Joi.number().integer().min(1).max(200).optional(),
        learnerId: objectId.optional(),
        esolLevel: Joi.string().trim().optional(),
        topic: Joi.string().trim().optional(),
        search: Joi.string().trim().optional().allow(""),
      }),
    },
    { context: true },
    { abortEarly: false }
  );

export const updateMasteryValidation = () =>
  validate(
    {
      params: Joi.object({ vocabId: objectId.required() }),
      body: Joi.object({
        masteryScore: Joi.number().min(0).max(1).required().messages({
          "any.required": "Mastery score is required",
        }),
      }),
    },
    { context: true },
    { abortEarly: false }
  );
