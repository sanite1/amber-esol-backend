import { Joi, validate } from "express-validation";

/* ── GET /tutor-dashboard ── */

const getTutorDashboardSchema = {
  query: Joi.object({
    upcomingLimit: Joi.string().optional().messages({
      "string.base": "upcomingLimit must be a string",
    }),
    messagesLimit: Joi.string().optional().messages({
      "string.base": "messagesLimit must be a string",
    }),
  })
    .unknown(false)
    .messages({
      "object.unknown": 'Query parameter "{{#label}}" is not supported',
    }),
};

export const getTutorDashboardValidation = () =>
  validate(getTutorDashboardSchema, { context: true }, { abortEarly: false });
