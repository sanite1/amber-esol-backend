/**
 * Joi validation for the admin + org-admin safeguarding routes
 * (brief Function 10 / Function 15).
 *
 * Whitelist the brief's documented filters and reject everything else
 * via `.unknown(false)`. A future filter addition needs an explicit
 * schema change — this stops a careless caller from probing query
 * params that aren't part of the supported API surface.
 */

import { Joi, validate } from "express-validation";
import { Types } from "mongoose";

// Joi custom rule — defer ObjectId validation to mongoose so we don't
// have to maintain a parallel regex.
const objectIdRule = (value: string, helpers: { error: (code: string) => unknown }) => {
  if (!Types.ObjectId.isValid(value)) return helpers.error("any.invalid");
  return value;
};

const SAFEGUARDING_CATEGORIES = [
  "self_harm",
  "domestic_abuse",
  "radicalisation",
  "child_concern",
  "child_protection", // accept both naming dialects — see SAFEGUARDING_REVIEW.md
  "exploitation",
  "mental_health_crisis",
] as const;

// ─────────────────────────────────────────────────────────────────────
// GET /api/admin/safeguarding
// ─────────────────────────────────────────────────────────────────────

const listAdminSchema = {
  query: Joi.object({
    resolved: Joi.string().valid("true", "false").optional(),
    org_id: Joi.string().custom(objectIdRule, "ObjectId").optional(),
    category: Joi.string()
      .valid(...SAFEGUARDING_CATEGORIES)
      .optional(),
    page: Joi.string().pattern(/^[1-9]\d*$/).optional(),
    limit: Joi.string().pattern(/^[1-9]\d*$/).optional(),
    // Function 15 To-Do 2 — `?summary=true` switches the response to
    // aggregate counts (by category, by org, >24h unresolved,
    // avg resolution time). `?days=N` narrows the window applied to
    // BOTH the list and the summary; 1–365 days inclusive.
    summary: Joi.string().valid("true", "false").optional(),
    days: Joi.string()
      .pattern(/^[1-9]\d*$/)
      .custom((value, helpers) => {
        const n = Number.parseInt(value, 10);
        if (n < 1 || n > 365) return helpers.error("any.invalid");
        return value;
      }, "days range")
      .messages({ "any.invalid": "days must be an integer between 1 and 365" })
      .optional(),
  })
    .unknown(false)
    .messages({
      "object.unknown": 'Query parameter "{#label}" is not supported',
    }),
};

export const listAdminSafeguardingValidation = () =>
  validate(listAdminSchema, { context: true }, { abortEarly: false });

// ─────────────────────────────────────────────────────────────────────
// GET /api/admin/safeguarding/:id  (and PATCH)
// ─────────────────────────────────────────────────────────────────────

const idParamSchema = {
  params: Joi.object({
    id: Joi.string().custom(objectIdRule, "ObjectId").required(),
  }),
};

export const adminSafeguardingIdParamValidation = () =>
  validate(idParamSchema, { context: true }, { abortEarly: false });

// ─────────────────────────────────────────────────────────────────────
// PATCH /api/admin/safeguarding/:id
// ─────────────────────────────────────────────────────────────────────

const resolveSchema = {
  params: Joi.object({
    id: Joi.string().custom(objectIdRule, "ObjectId").required(),
  }),
  body: Joi.object({
    resolution_notes: Joi.string()
      .trim()
      .min(1)
      .max(4_000)
      .required()
      .messages({
        "any.required": "resolution_notes is required",
        "string.empty": "resolution_notes must be a non-empty string",
        "string.max": "resolution_notes must be 4000 characters or fewer",
      }),
  }).unknown(false),
};

export const resolveAdminSafeguardingValidation = () =>
  validate(resolveSchema, { context: true }, { abortEarly: false });

// ─────────────────────────────────────────────────────────────────────
// GET /api/org-admin/safeguarding/count
// ─────────────────────────────────────────────────────────────────────

const orgAdminCountSchema = {
  query: Joi.object({
    resolved: Joi.string().valid("true", "false").optional(),
  })
    .unknown(false)
    .messages({
      "object.unknown": 'Query parameter "{#label}" is not supported',
    }),
};

export const orgAdminSafeguardingCountValidation = () =>
  validate(orgAdminCountSchema, { context: true }, { abortEarly: false });
