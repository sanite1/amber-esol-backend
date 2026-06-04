/**
 * Joi validation for the admin ComplianceConfig endpoints — Final
 * Addendum §3.
 *
 * The service does the semantic checks (rules shape, changelog
 * length, domain whitelist); Joi handles the shape gate so a bad
 * request never reaches the service.
 */

import { Joi, validate } from "express-validation";

const DOMAINS = ["ilr", "rarpa", "asf-routing"] as const;
const ACADEMIC_YEAR_PATTERN = /^\d{4}\/\d{2}$/;

// ─────────────────────────────────────────────────────────────────────
// GET /:domain/:academicYear/active
// ─────────────────────────────────────────────────────────────────────

const activeParamsSchema = {
  params: Joi.object({
    domain: Joi.string()
      .valid(...DOMAINS)
      .required(),
    academicYear: Joi.string()
      .pattern(ACADEMIC_YEAR_PATTERN)
      .required()
      .messages({
        "string.pattern.base": "academicYear must be YYYY/YY (e.g. 2025/26)",
      }),
  }),
};

export const getActiveComplianceConfigValidation = () =>
  validate(activeParamsSchema, { context: true }, { abortEarly: false });

// ─────────────────────────────────────────────────────────────────────
// POST / — activate a new version
// ─────────────────────────────────────────────────────────────────────

const activateBodySchema = {
  body: Joi.object({
    domain: Joi.string()
      .valid(...DOMAINS)
      .required(),
    academic_year: Joi.string()
      .pattern(ACADEMIC_YEAR_PATTERN)
      .required()
      .messages({
        "string.pattern.base": "academic_year must be YYYY/YY (e.g. 2025/26)",
      }),
    // `rules` is a free-form JSON object — schema-validated downstream
    // by the consuming pipelines (ILR field mapping etc). Here we just
    // ensure it IS an object, not a string or array.
    rules: Joi.object().required(),
    changelog: Joi.string().trim().min(1).max(4000).required().messages({
      "any.required": "changelog is required",
      "string.empty": "changelog must be non-empty",
      "string.max": "changelog must be 4000 characters or fewer",
    }),
  }).unknown(false),
};

export const activateComplianceConfigValidation = () =>
  validate(activateBodySchema, { context: true }, { abortEarly: false });
