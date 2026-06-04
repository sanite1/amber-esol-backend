import { Joi, validate } from "express-validation";

/**
 * POST /api/esol/declare-eligibility body validation.
 *
 * Single-field body. `declaration` must be the literal boolean `true` —
 * `false` is rejected because the API only records affirmative declarations.
 * (A learner who declines simply doesn't call the endpoint.)
 *
 * The visible declaration text the learner sees is rendered on the
 * frontend and translated to all 5 MVP languages; the API trusts the
 * frontend to display the correct text and only records the consent.
 *
 * `unknown(false)` blocks injected fields like `funding_status` overrides
 * — funding_status is set server-side from the postcode lookup.
 */
export const declareEligibilityValidation = () =>
  validate(
    {
      body: Joi.object({
        declaration: Joi.boolean().valid(true).required().messages({
          "any.only": "declaration must be true to confirm eligibility",
          "any.required": "declaration is required",
        }),
      }).unknown(false),
    },
    { context: true },
    { abortEarly: false }
  );
