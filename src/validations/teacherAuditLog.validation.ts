/**
 * Joi validation for GET /api/teacher/learners/:id/audit-log — Final
 * Addendum §6 (BE-C). Accepts action + date range + pagination;
 * learner_id comes from the route param.
 */

import { Joi, validate } from "express-validation";
import {
  dateLikeRule,
  objectIdRule,
  pageRule,
  limitRule,
} from "./auditLogShared.validation";

const schema = {
  params: Joi.object({
    id: Joi.string().custom(objectIdRule, "ObjectId").required(),
  }),
  query: Joi.object({
    action: Joi.string().trim().max(80).optional(),
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

export const teacherAuditLogValidation = () =>
  validate(schema, { context: true }, { abortEarly: false });
