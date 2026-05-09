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

export const sessionIdParamValidation = () =>
  validate(
    { params: Joi.object({ sessionId: objectId.required() }) },
    { context: true },
    { abortEarly: false }
  );

export const submitLearnerFeedbackValidation = () =>
  validate(
    {
      params: Joi.object({ sessionId: objectId.required() }),
      body: Joi.object({
        rating: Joi.number().integer().min(1).max(5).required().messages({
          "any.required": "Rating is required",
          "number.min": "Rating must be between 1 and 5",
          "number.max": "Rating must be between 1 and 5",
        }),
        comment: Joi.string().trim().max(2000).optional().allow(""),
        topicsWorkedOn: Joi.array().items(Joi.string().trim()).optional(),
      }),
    },
    { context: true },
    { abortEarly: false }
  );

export const submitTeacherFeedbackValidation = () =>
  validate(
    {
      params: Joi.object({ sessionId: objectId.required() }),
      body: Joi.object({
        rating: Joi.number().integer().min(1).max(5).optional(),
        comment: Joi.string().trim().max(2000).optional().allow(""),
        progressNotes: Joi.string().trim().max(4000).optional().allow(""),
        topicsWorkedOn: Joi.array().items(Joi.string().trim()).optional(),
      }).min(1),
    },
    { context: true },
    { abortEarly: false }
  );
