/**
 * Joi validation for the admin GLH analytics endpoint —
 * Final Addendum §12.
 *
 *   GET /api/admin/glh-analytics
 *
 * Query-string only. Window defaults are applied in the service
 * (omitted from / to → trailing 30-day window).
 */

import { Joi, validate } from "express-validation";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const schema = {
  query: Joi.object({
    from: Joi.string().pattern(ISO_DATE).optional().messages({
      "string.pattern.base": "from must be YYYY-MM-DD",
    }),
    to: Joi.string().pattern(ISO_DATE).optional().messages({
      "string.pattern.base": "to must be YYYY-MM-DD",
    }),
    org_id: Joi.string()
      .pattern(/^[a-fA-F0-9]{24}$/)
      .optional()
      .messages({
        "string.pattern.base": "org_id must be a 24-char ObjectId",
      }),
  }).unknown(false),
};

export const glhAnalyticsValidation = () =>
  validate(schema, { context: true }, { abortEarly: false });
