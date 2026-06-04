/**
 * Joi validation for GET /api/org-admin/audit-log — Final Addendum §6.
 *
 * Mirrors the runtime bounds in orgAdminAuditLog.service.ts. The
 * service does its own validation (defence in depth); Joi here
 * catches shape errors at the boundary.
 */

import { Joi, validate } from "express-validation";
import { Types } from "mongoose";

const objectIdRule = (
  value: string,
  helpers: { error: (code: string) => unknown },
) => {
  if (!Types.ObjectId.isValid(value)) return helpers.error("any.invalid");
  return value;
};

// YYYY-MM-DD or full ISO timestamp. Joi's `date.iso` is too strict
// (wants the full form); accept either via a custom rule.
const dateLikeRule = (
  value: string,
  helpers: { error: (code: string) => unknown },
) => {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const d = new Date(value);
  if (!Number.isNaN(d.getTime())) return value;
  return helpers.error("any.invalid");
};

const auditLogSchema = {
  query: Joi.object({
    learner_id: Joi.string().custom(objectIdRule, "ObjectId").optional(),
    // Free-form action — the service validates against the enum.
    // Letting Joi just enforce a length cap keeps this file decoupled
    // from the AuditAction enum changes.
    action: Joi.string().trim().max(80).optional(),
    from: Joi.string().custom(dateLikeRule, "date-like").optional(),
    to: Joi.string().custom(dateLikeRule, "date-like").optional(),
    page: Joi.string()
      .pattern(/^[1-9]\d*$/)
      .optional()
      .messages({
        "string.pattern.base": "page must be a positive integer",
      }),
    limit: Joi.string()
      .pattern(/^[1-9]\d*$/)
      .custom((value, helpers) => {
        const n = parseInt(value, 10);
        if (!Number.isFinite(n) || n < 10 || n > 200) {
          return helpers.error("any.invalid");
        }
        return value;
      }, "limit range")
      .optional()
      .messages({
        "any.invalid": "limit must be an integer between 10 and 200",
        "string.pattern.base":
          "limit must be a positive integer between 10 and 200",
      }),
  })
    .unknown(false)
    .messages({
      "object.unknown": 'Query parameter "{#label}" is not supported',
    }),
};

export const orgAdminAuditLogValidation = () =>
  validate(auditLogSchema, { context: true }, { abortEarly: false });
