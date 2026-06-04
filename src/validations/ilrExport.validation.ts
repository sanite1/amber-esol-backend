/**
 * Joi validation for the ILR export endpoints — brief Function 13.
 *
 * Trigger body is the only one with shape requirements; the GET
 * endpoints have only path params, which the controllers + service
 * validate inline.
 */

import { Joi, validate } from "express-validation";

const triggerSchema = {
  body: Joi.object({
    academic_year: Joi.string()
      .pattern(/^\d{4}\/\d{2}$/)
      .required()
      .messages({
        "string.pattern.base": "academic_year must be YYYY/YY (e.g. 2025/26)",
      }),
    period_start: Joi.string()
      .pattern(/^\d{4}-\d{2}-\d{2}$/)
      .required()
      .messages({ "string.pattern.base": "period_start must be YYYY-MM-DD" }),
    period_end: Joi.string()
      .pattern(/^\d{4}-\d{2}-\d{2}$/)
      .required()
      .messages({ "string.pattern.base": "period_end must be YYYY-MM-DD" }),
  }).unknown(false),
  query: Joi.object({
    force_refresh: Joi.string().valid("true", "false").optional(),
  }).unknown(false),
};

export const triggerIlrExportValidation = () =>
  validate(triggerSchema, { context: true }, { abortEarly: false });

const downloadQuerySchema = {
  query: Joi.object({
    format: Joi.string().valid("csv", "json").optional(),
  }).unknown(false),
};

export const downloadIlrExportValidation = () =>
  validate(downloadQuerySchema, { context: true }, { abortEarly: false });
