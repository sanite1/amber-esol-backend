/**
 * Joi validation for the admin MIS settings endpoints — Final
 * Addendum §7.
 *
 * The service does the deep checks (URL parsing, encryption, MIS
 * type enforcement on the typed enum); Joi handles the shape gate.
 *
 * `misApiCredentials` is allowed to be:
 *   - a non-empty string (plaintext, will be encrypted)
 *   - an empty string (clear stored credentials)
 *   - null (clear, alternate form)
 *   - undefined (omitted — leaves existing ciphertext intact)
 *
 * That last case is critical: the UI never echoes the existing
 * credential value, so re-saving the form without retyping must NOT
 * wipe what's already stored.
 */

import { Joi, validate } from "express-validation";

const MIS_TYPES = ["ProSolution", "Maytas", "EBS", "none"] as const;

const updateMisSettingsSchema = {
  params: Joi.object({
    id: Joi.string()
      .pattern(/^[a-fA-F0-9]{24}$/)
      .required(),
  }),
  body: Joi.object({
    misType: Joi.string()
      .valid(...MIS_TYPES)
      .optional(),
    misApiEndpoint: Joi.string().uri().allow(null, "").optional().messages({
      "string.uri": "misApiEndpoint must be a valid URL (incl. scheme)",
    }),
    // Cap length to defend against pathological inputs — a real MIS
    // credential is a token or a short JSON blob, never megabytes.
    misApiCredentials: Joi.string().max(8192).allow(null, "").optional(),
  })
    .min(1)
    .unknown(false)
    .messages({
      "object.min": "Provide at least one of misType, misApiEndpoint, misApiCredentials",
    }),
};

export const updateMisSettingsValidation = () =>
  validate(updateMisSettingsSchema, { context: true }, { abortEarly: false });

const testConnectionSchema = {
  params: Joi.object({
    id: Joi.string()
      .pattern(/^[a-fA-F0-9]{24}$/)
      .required(),
  }),
};

export const testMisConnectionValidation = () =>
  validate(testConnectionSchema, { context: true }, { abortEarly: false });
