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

export const ilrReportValidation = () =>
  validate(
    {
      query: Joi.object({
        orgId: objectId.required(),
        periodStart: Joi.string().isoDate().required(),
        periodEnd: Joi.string().isoDate().required(),
      }),
    },
    { context: true },
    { abortEarly: false },
  );
