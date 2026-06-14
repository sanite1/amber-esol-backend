/**
 * Joi validation for the org-admin onboarding embed endpoints —
 * Phase 2 / Final Addendum §13 (BE-G).
 *
 *   GET  /api/org-admin/onboarding/status     no body, no params
 *   POST /api/org-admin/onboarding/complete   optional { source }
 *
 * Body is intentionally minimal. The frontend sends one of:
 *   { source: "roi_calculator_submitted" }
 *   { source: "skipped" }
 * Anything else is allowed but truncated to a sensible length so the
 * audit row's `reason` field can't be used for log injection.
 */

import { Joi, validate } from "express-validation";

const completeSchema = {
  body: Joi.object({
    source: Joi.string().trim().max(80).optional(),
  })
    .unknown(false)
    .messages({
      "object.unknown": 'Body field "{#label}" is not supported',
    }),
};

export const markOrgOnboardingCompleteValidation = () =>
  validate(completeSchema, { context: true }, { abortEarly: false });
