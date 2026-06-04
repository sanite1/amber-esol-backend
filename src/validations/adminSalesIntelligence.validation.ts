/**
 * Joi validation for the admin sales-intelligence endpoints —
 * Final Addendum §13.
 */

import { Joi, validate } from "express-validation";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const OBJECT_ID = /^[a-fA-F0-9]{24}$/;

// ── GET /admin/sales-intelligence/roi-submissions ─────────────────
const listSchema = {
  query: Joi.object({
    contacted: Joi.string().valid("true", "false").optional(),
    from: Joi.string().pattern(ISO_DATE).optional().messages({
      "string.pattern.base": "from must be YYYY-MM-DD",
    }),
    to: Joi.string().pattern(ISO_DATE).optional().messages({
      "string.pattern.base": "to must be YYYY-MM-DD",
    }),
    org_type: Joi.string()
      .valid("college", "council", "charity", "employer")
      .optional(),
    page: Joi.string().pattern(/^\d+$/).optional(),
    limit: Joi.string().pattern(/^\d+$/).optional(),
  }).unknown(false),
};

// ── PATCH /admin/.../:id/contacted ────────────────────────────────
const markContactedSchema = {
  params: Joi.object({
    id: Joi.string().pattern(OBJECT_ID).required().messages({
      "string.pattern.base": "submission id must be a 24-char ObjectId",
    }),
  }),
};

export const listRoiSubmissionsValidation = () =>
  validate(listSchema, { context: true }, { abortEarly: false });

export const markRoiSubmissionContactedValidation = () =>
  validate(markContactedSchema, { context: true }, { abortEarly: false });
