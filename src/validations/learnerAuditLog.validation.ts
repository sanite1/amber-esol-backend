/**
 * Joi validation for GET /api/learner/me/audit-log — Final Addendum
 * §6 (BE-A). The learner endpoint accepts ONLY date range +
 * pagination — no learner_id (locked by service), no action filter.
 */

import { Joi, validate } from "express-validation";
import { dateLikeRule, pageRule, limitRule } from "./auditLogShared.validation";

const schema = {
  query: Joi.object({
    from: Joi.string().custom(dateLikeRule, "date-like").optional(),
    to: Joi.string().custom(dateLikeRule, "date-like").optional(),
    page: pageRule,
    limit: limitRule,
  })
    .unknown(false)
    .messages({
      "object.unknown": 'Query parameter "{#label}" is not supported',
    }),
};

export const learnerAuditLogValidation = () =>
  validate(schema, { context: true }, { abortEarly: false });
