/**
 * Joi validation for POST /api/public/roi-calculator/submit —
 * Final Addendum §13.
 *
 * Defence-in-depth alongside the service's recompute: a malformed
 * body 400s here before the service runs.
 */

import { Joi, validate } from "express-validation";

const schema = {
  body: Joi.object({
    waiting_list_size: Joi.number().integer().min(1).max(10_000).required(),
    avg_asf_rate: Joi.number().min(100).max(2_000).required(),
    org_name: Joi.string().trim().max(120).allow("").optional(),
    org_type: Joi.string()
      .valid("college", "council", "charity", "employer")
      .allow(null, "")
      .optional(),
    current_throughput_per_year: Joi.number()
      .integer()
      .min(0)
      .max(10_000)
      .optional(),
    contact_email: Joi.string()
      .trim()
      .email({ tlds: { allow: false } })
      .max(254)
      .allow("", null)
      .optional(),
    contact_name: Joi.string().trim().max(120).allow("", null).optional(),
  }).unknown(false),
};

export const submitRoiCalculatorValidation = () =>
  validate(schema, { context: true }, { abortEarly: false });
