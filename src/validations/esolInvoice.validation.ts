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

export const generateInvoiceValidation = () =>
  validate(
    {
      body: Joi.object({
        orgId: objectId.required(),
        periodStart: Joi.string().isoDate().required().messages({
          "any.required": "Period start is required",
        }),
        periodEnd: Joi.string().isoDate().required().messages({
          "any.required": "Period end is required",
        }),
        notes: Joi.string().trim().max(1000).optional().allow(""),
      }),
    },
    { context: true },
    { abortEarly: false },
  );

export const listInvoicesValidation = () =>
  validate(
    {
      query: Joi.object({
        page: Joi.number().integer().min(1).optional(),
        limit: Joi.number().integer().min(1).max(100).optional(),
        status: Joi.string()
          .valid("draft", "issued", "paid", "overdue", "cancelled")
          .optional(),
        orgId: objectId.optional(),
      }),
    },
    { context: true },
    { abortEarly: false },
  );

export const invoiceIdParamValidation = () =>
  validate(
    { params: Joi.object({ invoiceId: objectId.required() }) },
    { context: true },
    { abortEarly: false },
  );

export const markPaidValidation = () =>
  validate(
    {
      params: Joi.object({ invoiceId: objectId.required() }),
      body: Joi.object({
        paidAt: Joi.string().isoDate().optional(),
        notes: Joi.string().trim().max(1000).optional().allow(""),
      }),
    },
    { context: true },
    { abortEarly: false },
  );
