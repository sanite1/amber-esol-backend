import { Joi, validate } from "express-validation";

/* ── GET /api/student-dashboard ── */

const getStudentDashboardSchema = {
  query: Joi.object({
    upcomingLimit: Joi.string().optional().messages({
      "string.base": "upcomingLimit must be a string",
    }),
    messagesLimit: Joi.string().optional().messages({
      "string.base": "messagesLimit must be a string",
    }),
    recommendedLimit: Joi.string().optional().messages({
      "string.base": "recommendedLimit must be a string",
    }),
  })
    .unknown(false)
    .messages({
      "object.unknown": 'Query parameter "{{#label}}" is not supported',
    }),
};

export const getStudentDashboardValidation = () =>
  validate(getStudentDashboardSchema, { context: true }, { abortEarly: false });
