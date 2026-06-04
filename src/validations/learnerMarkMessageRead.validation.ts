/**
 * Joi validation for the mark-message-read endpoint —
 * Final Addendum §11.
 *
 *   PATCH /api/esol/messages/:id/read
 *
 * Path id only — no body. The ownership gate + idempotency live
 * in the service.
 */

import { Joi, validate } from "express-validation";

const schema = {
  params: Joi.object({
    id: Joi.string()
      .pattern(/^[a-fA-F0-9]{24}$/)
      .required()
      .messages({
        "string.pattern.base": "message id must be a 24-char ObjectId",
      }),
  }),
};

export const markMessageReadValidation = () =>
  validate(schema, { context: true }, { abortEarly: false });
