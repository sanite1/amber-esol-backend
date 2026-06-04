/**
 * Joi validation for the evidence-report endpoints — brief Function 14.
 *
 * Two distinct trigger schemas:
 *   - org-admin: { period_start, period_end }  (org_id comes from JWT
 *                                                 + requireOrgContext)
 *   - Amber admin: { org_id, period_start, period_end }
 *                                                 (no requireOrgContext)
 *
 * The 12-month bound and the "start before end" check live in the
 * service layer — Joi gives us shape and pattern; semantic rules
 * belong with the rest of the business logic.
 */

import { Joi, validate } from "express-validation";

// Org-admin trigger — period only
const orgAdminTriggerSchema = {
  body: Joi.object({
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

export const triggerEvidenceReportOrgAdminValidation = () =>
  validate(orgAdminTriggerSchema, { context: true }, { abortEarly: false });

// Amber-admin trigger — org_id required in the body
const adminTriggerSchema = {
  body: Joi.object({
    org_id: Joi.string()
      .pattern(/^[a-fA-F0-9]{24}$/)
      .required()
      .messages({ "string.pattern.base": "org_id must be a 24-char ObjectId" }),
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

export const triggerEvidenceReportAdminValidation = () =>
  validate(adminTriggerSchema, { context: true }, { abortEarly: false });
