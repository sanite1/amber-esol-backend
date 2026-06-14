/**
 * Joi validation for the teacher preferences endpoint —
 * Final Addendum §11.
 *
 *   PATCH /api/teacher/preferences/auto-re-engagement
 *
 * Single-field body. Joi is overkill for one boolean but matches
 * the convention of every other teacher route so the wiring stays
 * uniform.
 */

import { Joi, validate } from "express-validation";

const schema = {
  body: Joi.object({
    auto_re_engagement_enabled: Joi.boolean().required().messages({
      "any.required": "auto_re_engagement_enabled is required (boolean)",
    }),
  }).unknown(false),
};

export const updateAutoReEngagementValidation = () =>
  validate(schema, { context: true }, { abortEarly: false });
