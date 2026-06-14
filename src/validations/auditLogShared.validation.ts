/**
 * Shared Joi pieces for every audit-log endpoint — Final Addendum §6.
 *
 * Extracted in Phase 1 so the org-admin, learner-self, and teacher
 * audit-log endpoints don't redefine the same date / page / limit
 * rules independently. Each endpoint's validation file imports just
 * the bits it accepts.
 */

import { Joi } from "express-validation";
import { Types } from "mongoose";

export const objectIdRule = (
  value: string,
  helpers: { error: (code: string) => unknown },
) => {
  if (!Types.ObjectId.isValid(value)) return helpers.error("any.invalid");
  return value;
};

/**
 * YYYY-MM-DD shorthand OR full ISO timestamp. Joi's built-in
 * `date.iso` is too strict (wants the full form); accept either via
 * this custom rule. Matches `parseDateFilter` in the services.
 */
export const dateLikeRule = (
  value: string,
  helpers: { error: (code: string) => unknown },
) => {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const d = new Date(value);
  if (!Number.isNaN(d.getTime())) return value;
  return helpers.error("any.invalid");
};

export const pageRule = Joi.string()
  .pattern(/^[1-9]\d*$/)
  .optional()
  .messages({
    "string.pattern.base": "page must be a positive integer",
  });

export const limitRule = Joi.string()
  .pattern(/^[1-9]\d*$/)
  .custom((value: string, helpers: { error: (code: string) => unknown }) => {
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
  });
