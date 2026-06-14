/**
 * Joi validations for the admin MIS sync endpoints —
 * Phase 4 / Final Addendum §7 (BE-D).
 *
 *   GET  /:id/mis/sync-logs                    page/limit
 *   GET  /:id/mis/conflicts                    page/limit
 *   POST /:id/mis/sync-now                     optional { ulns: string[] }
 *   POST /:id/mis/conflicts/:conflictId/resolve optional { note }
 *
 * `:id` (organisation id) validation lives at the service layer —
 * a 24-hex check via mongoose.Types.ObjectId.isValid keeps things
 * uniform across the codebase. We avoid re-validating at this
 * layer to keep one source of truth for the 400 message.
 */

import { Joi, validate } from "express-validation";

// ─────────────────────────────────────────────────────────────────────
// Shared bounds — mirror the service's pagination clamp so a 400
// from validation reads identically whether the cap was tripped at
// the route layer or the service layer.
// ─────────────────────────────────────────────────────────────────────

const pageRule = Joi.string()
  .pattern(/^\d+$/)
  .custom((v: string, helpers) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 1) {
      return helpers.message({ custom: "page must be an integer ≥ 1" });
    }
    return v;
  })
  .optional();

const limitRule = Joi.string()
  .pattern(/^\d+$/)
  .custom((v: string, helpers) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 10 || n > 200) {
      return helpers.message({
        custom: "limit must be an integer between 10 and 200",
      });
    }
    return v;
  })
  .optional();

const listSchema = {
  query: Joi.object({
    page: pageRule,
    limit: limitRule,
  })
    .unknown(false)
    .messages({
      "object.unknown": 'Query parameter "{#label}" is not supported',
    }),
};

export const listMisSyncQueryValidation = () =>
  validate(listSchema, { context: true }, { abortEarly: false });

// ─────────────────────────────────────────────────────────────────────
// POST /sync-now — optional explicit ULN list
// ─────────────────────────────────────────────────────────────────────

const syncNowSchema = {
  body: Joi.object({
    ulns: Joi.array()
      .items(Joi.string().trim().max(40))
      .min(1)
      .max(500)
      .optional(),
  })
    .unknown(false)
    .messages({
      "object.unknown": 'Body field "{#label}" is not supported',
      "array.max":
        "ulns may not exceed 500 entries — split into multiple calls",
    }),
};

export const triggerSyncNowValidation = () =>
  validate(syncNowSchema, { context: true }, { abortEarly: false });

// ─────────────────────────────────────────────────────────────────────
// POST /:conflictId/resolve — optional note
// ─────────────────────────────────────────────────────────────────────

const resolveConflictSchema = {
  body: Joi.object({
    note: Joi.string().trim().max(500).optional(),
  })
    .unknown(false)
    .messages({
      "object.unknown": 'Body field "{#label}" is not supported',
    }),
};

export const resolveConflictValidation = () =>
  validate(resolveConflictSchema, { context: true }, { abortEarly: false });
