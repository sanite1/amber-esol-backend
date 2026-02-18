import { Joi, validate } from "express-validation";
import { Types } from "mongoose";

/* ── Helper: ObjectId validator ── */

const objectId = Joi.string()
  .custom((value, helpers) => {
    if (!Types.ObjectId.isValid(value)) {
      return helpers.error("any.invalid");
    }
    return value;
  }, "ObjectId validation")
  .messages({
    "any.invalid": "{{#label}} must be a valid ID",
    "string.base": "{{#label}} must be a string",
    "any.required": "{{#label}} is required",
  });

const dateString = Joi.string()
  .pattern(/^\d{4}-\d{2}-\d{2}$/)
  .messages({
    "string.pattern.base": "{{#label}} must be in YYYY-MM-DD format",
  });

/* ══════════════════════════════════════════════
   Schemas
   ══════════════════════════════════════════════ */

/* ── POST /payments/create-intent ── */

const createPaymentIntentSchema = {
  body: Joi.object({
    bookingId: objectId.required().messages({
      "any.required": "Booking ID is required",
    }),
  })
    .unknown(false)
    .messages({
      "object.unknown": 'Field "{{#label}}" is not allowed',
    }),
};

/* ── GET /payments/transactions ── */

const listTransactionsSchema = {
  query: Joi.object({
    page: Joi.string().optional(),
    limit: Joi.string().optional(),
    status: Joi.string()
      .valid("pending", "paid", "refunded", "failed")
      .optional()
      .messages({
        "any.only": "Status must be one of: pending, paid, refunded, failed",
      }),
    type: Joi.string().valid("lesson", "trial", "package").optional().messages({
      "any.only": "Type must be one of: lesson, trial, package",
    }),
    dateFrom: dateString.optional(),
    dateTo: dateString.optional(),
    search: Joi.string().optional().allow(""),
    sort: Joi.string()
      .valid("newest", "oldest", "amount_high", "amount_low")
      .optional()
      .messages({
        "any.only":
          "Sort must be one of: newest, oldest, amount_high, amount_low",
      }),
  })
    .unknown(false)
    .messages({
      "object.unknown": 'Query parameter "{{#label}}" is not supported',
    }),
};

/* ── GET /payments/transactions/:id ── */

const getTransactionByIdSchema = {
  params: Joi.object({
    id: objectId.required().messages({
      "any.required": "Transaction ID is required",
    }),
  }),
};

/* ── POST /payments/payouts ── */

const requestPayoutSchema = {
  body: Joi.object({
    amount: Joi.number().positive().required().messages({
      "number.base": "Amount must be a number",
      "number.positive": "Amount must be positive",
      "any.required": "Amount is required",
    }),
    method: Joi.string().valid("bank_transfer", "paypal").required().messages({
      "any.only": 'Method must be either "bank_transfer" or "paypal"',
      "any.required": "Payout method is required",
    }),
    notes: Joi.string().optional().allow("").max(500),
  })
    .unknown(false)
    .messages({
      "object.unknown": 'Field "{{#label}}" is not allowed',
    }),
};

/* ── GET /payments/payouts ── */

const listPayoutsSchema = {
  query: Joi.object({
    page: Joi.string().optional(),
    limit: Joi.string().optional(),
    status: Joi.string()
      .valid("pending", "processing", "completed", "failed", "flagged")
      .optional()
      .messages({
        "any.only":
          "Status must be one of: pending, processing, completed, failed, flagged",
      }),
    sort: Joi.string()
      .valid("newest", "oldest", "amount_high", "amount_low")
      .optional(),
  })
    .unknown(false)
    .messages({
      "object.unknown": 'Query parameter "{{#label}}" is not supported',
    }),
};

/* ── PATCH /payments/payouts/:id/approve ── */

const approvePayoutSchema = {
  params: Joi.object({
    id: objectId.required(),
  }),
  body: Joi.object({
    notes: Joi.string().optional().allow("").max(500),
  })
    .unknown(false)
    .messages({
      "object.unknown": 'Field "{{#label}}" is not allowed',
    }),
};

/* ── PATCH /payments/payouts/:id/reject ── */

const rejectPayoutSchema = {
  params: Joi.object({
    id: objectId.required(),
  }),
  body: Joi.object({
    reason: Joi.string().required().max(500).messages({
      "any.required": "Rejection reason is required",
      "string.max": "Reason cannot exceed 500 characters",
    }),
  })
    .unknown(false)
    .messages({
      "object.unknown": 'Field "{{#label}}" is not allowed',
    }),
};

/* ── PATCH /payments/payouts/:id/complete ── */

const completePayoutSchema = {
  params: Joi.object({
    id: objectId.required(),
  }),
  body: Joi.object({
    reference: Joi.string().optional().allow("").max(200),
    notes: Joi.string().optional().allow("").max(500),
  })
    .unknown(false)
    .messages({
      "object.unknown": 'Field "{{#label}}" is not allowed',
    }),
};

/* ── POST /payments/refund/:transactionId ── */

const refundTransactionSchema = {
  params: Joi.object({
    transactionId: objectId.required().messages({
      "any.required": "Transaction ID is required",
    }),
  }),
  body: Joi.object({
    reason: Joi.string().optional().allow("").max(500),
  })
    .unknown(false)
    .messages({
      "object.unknown": 'Field "{{#label}}" is not allowed',
    }),
};

/* ── PATCH /payments/transactions/:id/flag ── */

const flagTransactionSchema = {
  params: Joi.object({
    id: objectId.required(),
  }),
  body: Joi.object({
    flagged: Joi.boolean().required().messages({
      "any.required": "Flagged status is required",
    }),
    flagReason: Joi.string().optional().allow("").max(500),
  })
    .unknown(false)
    .messages({
      "object.unknown": 'Field "{{#label}}" is not allowed',
    }),
};

/* ── POST /payments/methods ── */

const addPaymentMethodSchema = {
  body: Joi.object({
    type: Joi.string().valid("card", "paypal", "bank").required().messages({
      "any.only": 'Type must be one of: "card", "paypal", "bank"',
      "any.required": "Payment method type is required",
    }),
    stripePaymentMethodId: Joi.string().optional(),
    last4: Joi.string()
      .pattern(/^\d{4}$/)
      .required()
      .messages({
        "string.pattern.base": "last4 must be exactly 4 digits",
        "any.required": "last4 is required",
      }),
    brand: Joi.string().optional().allow(""),
    isDefault: Joi.boolean().optional(),
    bankName: Joi.string().optional().allow(""),
    accountHolderName: Joi.string().optional().allow(""),
    paypalEmail: Joi.string().email().optional().allow(""),
  })
    .unknown(false)
    .messages({
      "object.unknown": 'Field "{{#label}}" is not allowed',
    }),
};

/* ── DELETE /payments/methods/:id ── */

const removePaymentMethodSchema = {
  params: Joi.object({
    id: objectId.required(),
  }),
};

/* ── PATCH /payments/methods/:id/default ── */

const setDefaultPaymentMethodSchema = {
  params: Joi.object({
    id: objectId.required(),
  }),
};

/* ── GET /payments/chart/monthly ── */

const monthlyChartSchema = {
  query: Joi.object({
    year: Joi.string().optional(),
    months: Joi.string().optional(),
  })
    .unknown(false)
    .messages({
      "object.unknown": 'Query parameter "{{#label}}" is not supported',
    }),
};

/* ══════════════════════════════════════════════
   Exports
   ══════════════════════════════════════════════ */

export const createPaymentIntentValidation = () =>
  validate(createPaymentIntentSchema, { context: true }, { abortEarly: false });

export const listTransactionsValidation = () =>
  validate(listTransactionsSchema, { context: true }, { abortEarly: false });

export const getTransactionByIdValidation = () =>
  validate(getTransactionByIdSchema, { context: true }, { abortEarly: false });

export const requestPayoutValidation = () =>
  validate(requestPayoutSchema, { context: true }, { abortEarly: false });

export const listPayoutsValidation = () =>
  validate(listPayoutsSchema, { context: true }, { abortEarly: false });

export const approvePayoutValidation = () =>
  validate(approvePayoutSchema, { context: true }, { abortEarly: false });

export const rejectPayoutValidation = () =>
  validate(rejectPayoutSchema, { context: true }, { abortEarly: false });

export const completePayoutValidation = () =>
  validate(completePayoutSchema, { context: true }, { abortEarly: false });

export const refundTransactionValidation = () =>
  validate(refundTransactionSchema, { context: true }, { abortEarly: false });

export const flagTransactionValidation = () =>
  validate(flagTransactionSchema, { context: true }, { abortEarly: false });

export const addPaymentMethodValidation = () =>
  validate(addPaymentMethodSchema, { context: true }, { abortEarly: false });

export const removePaymentMethodValidation = () =>
  validate(removePaymentMethodSchema, { context: true }, { abortEarly: false });

export const setDefaultPaymentMethodValidation = () =>
  validate(
    setDefaultPaymentMethodSchema,
    { context: true },
    { abortEarly: false }
  );

export const monthlyChartValidation = () =>
  validate(monthlyChartSchema, { context: true }, { abortEarly: false });
