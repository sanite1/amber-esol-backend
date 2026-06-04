import { Joi, validate } from "express-validation";

/**
 * POST /api/esol/uln body validation.
 *
 * Two valid shapes:
 *   1. Confirm:  { uln: "1234567890", skip: false }
 *   2. Skip:     { skip: true }   (uln must be absent/null/empty)
 *
 * ULN format (brief Function 2 To-Do 4):
 *   - Exactly 10 digits
 *   - No spaces, no letters, no hyphens
 *   - Regex /^\d{10}$/
 *
 * The skip path is non-blocking by design: learners without their ULN
 * (refugees, asylum seekers, anyone without prior UK education records)
 * must still be able to start learning. The ILR export will flag
 * uln_status="pending" rows for the org admin to chase before the next
 * submission window.
 *
 * `unknown(false)` blocks injected fields like uln_status overrides —
 * uln_status is set server-side based on which branch is taken.
 */
export const declareUlnValidation = () =>
  validate(
    {
      body: Joi.object({
        uln: Joi.string()
          .pattern(/^\d{10}$/)
          .messages({
            "string.pattern.base":
              "uln must be exactly 10 digits (no spaces, letters, or punctuation)",
          })
          .when("skip", {
            is: true,
            // When skipping, uln must NOT be provided (forbid even empty
            // strings — the frontend should send { skip: true } alone).
            then: Joi.forbidden().messages({
              "any.unknown": "uln must not be provided when skip is true",
            }),
            otherwise: Joi.required().messages({
              "any.required": "uln is required unless skip is true",
            }),
          }),
        skip: Joi.boolean().required().messages({
          "any.required": "skip is required (true to defer, false to confirm a ULN)",
        }),
      }).unknown(false),
    },
    { context: true },
    { abortEarly: false }
  );
