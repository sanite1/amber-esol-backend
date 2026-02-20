import { Joi, validate } from "express-validation";

/* ── GET /api/admin-dashboard ── */

const getAdminDashboardSchema = {
  query: Joi.object({
    signupsLimit: Joi.string().optional().messages({
      "string.base": "signupsLimit must be a string",
    }),
    lessonsLimit: Joi.string().optional().messages({
      "string.base": "lessonsLimit must be a string",
    }),
    transactionsLimit: Joi.string().optional().messages({
      "string.base": "transactionsLimit must be a string",
    }),
    chartMonths: Joi.string().optional().messages({
      "string.base": "chartMonths must be a string",
    }),
  })
    .unknown(false)
    .messages({
      "object.unknown": 'Query parameter "{{#label}}" is not supported',
    }),
};

export const getAdminDashboardValidation = () =>
  validate(getAdminDashboardSchema, { context: true }, { abortEarly: false });
