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

export const listAlertsValidation = () =>
  validate(
    {
      query: Joi.object({
        page: Joi.number().integer().min(1).optional(),
        limit: Joi.number().integer().min(1).max(100).optional(),
        status: Joi.string()
          .valid("open", "reviewed", "escalated", "resolved", "dismissed")
          .optional(),
        alertLevel: Joi.string()
          .valid("low", "medium", "high", "critical")
          .optional(),
        orgId: objectId.optional(),
      }),
    },
    { context: true },
    { abortEarly: false },
  );

export const alertIdParamValidation = () =>
  validate(
    { params: Joi.object({ alertId: objectId.required() }) },
    { context: true },
    { abortEarly: false },
  );

export const reviewAlertValidation = () =>
  validate(
    {
      params: Joi.object({ alertId: objectId.required() }),
      body: Joi.object({
        status: Joi.string()
          .valid("reviewed", "escalated", "resolved", "dismissed")
          .required()
          .messages({
            "any.required": "Status is required",
            "any.only":
              "Status must be one of: reviewed, escalated, resolved, dismissed",
          }),
        resolution: Joi.string().trim().max(2000).optional().allow(""),
      }),
    },
    { context: true },
    { abortEarly: false },
  );
