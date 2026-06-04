/**
 * Joi validation for GET /api/org-admin/learners — Function 12 To-Do 1.
 *
 * Whitelisted query params with `.unknown(false)` — a typo'd filter
 * returns 400 rather than silently being ignored. The service does a
 * second pass on the same set; this layer just catches shape bugs at
 * the boundary.
 */

import { Joi, validate } from "express-validation";

const STATUS_VALUES = ["active", "inactive", "dormant"] as const;
const LEVEL_VALUES = ["e1", "e2", "e3", "l1", "l2"] as const;
const AIM_TYPE_VALUES = ["regulated", "non_regulated"] as const;

/**
 * Pagination bounds — must mirror cohortTable.service.ts constants:
 *   page  ≥ 1                  (positive integer)
 *   limit between 10 and 200   (default 50, set in service)
 * Search trimmed to ≤ 200 chars (regex compilation upper bound).
 */
const cohortTableSchema = {
  query: Joi.object({
    status: Joi.string()
      .valid(...STATUS_VALUES)
      .optional(),
    level: Joi.string()
      .valid(...LEVEL_VALUES)
      .optional(),
    aim_type: Joi.string()
      .valid(...AIM_TYPE_VALUES)
      .optional(),
    search: Joi.string().trim().max(200).optional().allow(""),
    // page: stringy integer ≥ 1. Reject "0", "-3", and "1.5".
    page: Joi.string()
      .pattern(/^[1-9]\d*$/)
      .optional()
      .messages({
        "string.pattern.base": "page must be a positive integer",
      }),
    // limit: stringy integer 10–200 inclusive.
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
        "string.pattern.base": "limit must be a positive integer between 10 and 200",
      }),
  })
    .unknown(false)
    .messages({
      "object.unknown": 'Query parameter "{#label}" is not supported',
    }),
};

export const cohortTableValidation = () =>
  validate(cohortTableSchema, { context: true }, { abortEarly: false });
