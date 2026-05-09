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

export const listLearnersValidation = () =>
  validate(
    {
      query: Joi.object({
        page: Joi.number().integer().min(1).optional(),
        limit: Joi.number().integer().min(1).max(100).optional(),
        search: Joi.string().trim().optional().allow(""),
        esolLevel: Joi.string().trim().optional().allow(""),
        fundingStatus: Joi.string()
          .valid("esfa_funded", "self_funded", "employer_funded")
          .optional(),
        orgId: objectId.optional(),
      }),
    },
    { context: true },
    { abortEarly: false }
  );

export const learnerIdParamValidation = () =>
  validate(
    { params: Joi.object({ learnerId: objectId.required() }) },
    { context: true },
    { abortEarly: false }
  );

export const updateLearnerValidation = () =>
  validate(
    {
      params: Joi.object({ learnerId: objectId.required() }),
      body: Joi.object({
        esolLevel: Joi.string().trim().optional().allow(""),
        l1Language: Joi.string().trim().optional().allow(""),
        uln: Joi.string().trim().optional().allow(""),
        ulnStatus: Joi.string()
          .valid("pending", "verified", "not_required")
          .optional(),
        fundingStatus: Joi.string()
          .valid("esfa_funded", "self_funded", "employer_funded")
          .optional(),
      }).min(1),
    },
    { context: true },
    { abortEarly: false }
  );
