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

/* ── Helper: HH:mm time string ── */

const timeString = Joi.string()
  .pattern(/^([01]\d|2[0-3]):([0-5]\d)$/)
  .messages({
    "string.pattern.base": "{{#label}} must be in HH:mm format (e.g. 09:00)",
    "string.base": "{{#label}} must be a string",
    "string.empty": "{{#label}} is required",
    "any.required": "{{#label}} is required",
  });

/* ── Helper: YYYY-MM-DD date string ── */

const dateString = Joi.string()
  .pattern(/^\d{4}-\d{2}-\d{2}$/)
  .messages({
    "string.pattern.base": "{{#label}} must be in YYYY-MM-DD format",
    "string.base": "{{#label}} must be a string",
    "string.empty": "{{#label}} is required",
    "any.required": "{{#label}} is required",
  });

/* ── Sub-schemas ── */

const slotSchema = Joi.object({
  date: dateString.required(),
  startTime: timeString.required(),
  endTime: timeString.required(),
})
  .custom((value, helpers) => {
    if (value.startTime >= value.endTime) {
      return helpers.error("any.custom", {
        message: "End time must be after start time",
      });
    }
    return value;
  })
  .unknown(false)
  .messages({
    "object.unknown": "{{#label}} is not a recognised slot field",
    "any.custom": "End time must be after start time",
  });

/* ══════════════════════════════════════════════
   Main schemas
   ══════════════════════════════════════════════ */

/* ── POST /bookings (create booking) ── */

const createBookingSchema = {
  body: Joi.object({
    tutorId: objectId.required().messages({
      "any.invalid": "Tutor ID must be a valid ID",
      "any.required": "Tutor ID is required",
    }),
    type: Joi.string()
      .valid("trial", "regular", "esol_consolidation")
      .required()
      .messages({
        "any.only":
          'Booking type must be one of "trial", "regular", or "esol_consolidation"',
        "any.required": "Booking type is required",
      }),
    slots: Joi.array().items(slotSchema).min(1).required().messages({
      "array.base": "Slots must be an array",
      "array.min": "At least one time slot is required",
      "any.required": "Slots are required",
    }),
    specialty: Joi.string().optional().allow("").max(200).messages({
      "string.base": "Specialty must be a string",
      "string.max": "Specialty cannot exceed 200 characters",
    }),
    notes: Joi.string().optional().allow("").max(500).messages({
      "string.base": "Notes must be a string",
      "string.max": "Notes cannot exceed 500 characters",
    }),
    message: Joi.string().optional().allow("").max(500).messages({
      "string.base": "Message must be a string",
      "string.max": "Message cannot exceed 500 characters",
    }),
    successUrl: Joi.string().uri().optional().messages({
      "string.base": "Success URL must be a string",
      "string.uri": "Success URL must be a valid URL",
    }),
    cancelUrl: Joi.string().uri().optional().messages({
      "string.base": "Cancel URL must be a string",
      "string.uri": "Cancel URL must be a valid URL",
    }),
  })
    .custom((value, helpers) => {
      // Trial bookings must have exactly 1 slot
      if (value.type === "trial" && value.slots && value.slots.length !== 1) {
        return helpers.error("any.custom", {
          message: "Trial bookings must have exactly one time slot",
        });
      }
      return value;
    })
    .unknown(false)
    .messages({
      "object.unknown": 'Field "{{#label}}" is not allowed',
      "any.custom": "Trial bookings must have exactly one time slot",
    }),
};

/* ── GET /bookings (list) ── */

const listBookingsSchema = {
  query: Joi.object({
    page: Joi.string().optional().messages({
      "string.base": "Page must be a string",
    }),
    limit: Joi.string().optional().messages({
      "string.base": "Limit must be a string",
    }),
    status: Joi.string()
      .valid(
        "pending",
        "confirmed",
        "completed",
        "cancelled_student",
        "cancelled_tutor",
        "cancelled_admin",
        "no_show",
      )
      .optional()
      .messages({
        "string.base": "Status must be a string",
        "any.only":
          "Status must be one of: pending, confirmed, completed, cancelled_student, cancelled_tutor, cancelled_admin, no_show",
      }),
    type: Joi.string().valid("trial", "regular").optional().messages({
      "string.base": "Type must be a string",
      "any.only": 'Type must be either "trial" or "regular"',
    }),
    dateFrom: dateString.optional(),
    dateTo: dateString.optional(),
    search: Joi.string().optional().allow("").messages({
      "string.base": "Search must be a string",
    }),
    sort: Joi.string()
      .valid("newest", "oldest", "price_high", "price_low")
      .optional()
      .messages({
        "string.base": "Sort must be a string",
        "any.only":
          "Sort must be one of: newest, oldest, price_high, price_low",
      }),
  })
    .unknown(false)
    .messages({
      "object.unknown": 'Query parameter "{{#label}}" is not supported',
    }),
};

/* ── GET /bookings/upcoming ── */

const upcomingBookingsSchema = {
  query: Joi.object({
    limit: Joi.string().optional().messages({
      "string.base": "Limit must be a string",
    }),
  })
    .unknown(false)
    .messages({
      "object.unknown": 'Query parameter "{{#label}}" is not supported',
    }),
};

/* ── GET /bookings/:id ── */

const getBookingByIdSchema = {
  params: Joi.object({
    id: objectId.required().messages({
      "any.invalid": "Booking ID must be a valid ID",
      "any.required": "Booking ID is required",
    }),
  }),
};

/* ── PATCH /bookings/:id/confirm ── */

const confirmBookingSchema = {
  params: Joi.object({
    id: objectId.required().messages({
      "any.invalid": "Booking ID must be a valid ID",
      "any.required": "Booking ID is required",
    }),
  }),
};

/* ── PATCH /bookings/:id/decline ── */

const declineBookingSchema = {
  params: Joi.object({
    id: objectId.required().messages({
      "any.invalid": "Booking ID must be a valid ID",
      "any.required": "Booking ID is required",
    }),
  }),
  body: Joi.object({
    reason: Joi.string().optional().allow("").max(500).messages({
      "string.base": "Reason must be a string",
      "string.max": "Reason cannot exceed 500 characters",
    }),
  })
    .unknown(false)
    .messages({
      "object.unknown": 'Field "{{#label}}" is not allowed',
    }),
};

/* ── PATCH /bookings/:id/cancel ── */

const cancelBookingSchema = {
  params: Joi.object({
    id: objectId.required().messages({
      "any.invalid": "Booking ID must be a valid ID",
      "any.required": "Booking ID is required",
    }),
  }),
  body: Joi.object({
    reason: Joi.string().optional().allow("").max(500).messages({
      "string.base": "Reason must be a string",
      "string.max": "Reason cannot exceed 500 characters",
    }),
  })
    .unknown(false)
    .messages({
      "object.unknown": 'Field "{{#label}}" is not allowed',
    }),
};

/* ── PATCH /bookings/:id/complete ── */

const completeBookingSchema = {
  params: Joi.object({
    id: objectId.required().messages({
      "any.invalid": "Booking ID must be a valid ID",
      "any.required": "Booking ID is required",
    }),
  }),
};

/* ── PATCH /bookings/:id/no-show ── */

const noShowBookingSchema = {
  params: Joi.object({
    id: objectId.required().messages({
      "any.invalid": "Booking ID must be a valid ID",
      "any.required": "Booking ID is required",
    }),
  }),
};

/* ── PATCH /bookings/:id/flag (admin) ── */

const flagBookingSchema = {
  params: Joi.object({
    id: objectId.required().messages({
      "any.required": "Booking ID is required",
    }),
  }),
  body: Joi.object({
    flagged: Joi.boolean().required().messages({
      "boolean.base": "Flagged must be a boolean",
      "any.required": "Flagged is required",
    }),
    flagReason: Joi.string().trim().max(500).optional().allow("").messages({
      "string.max": "Flag reason cannot exceed 500 characters",
    }),
  })
    .unknown(false)
    .messages({
      "object.unknown": 'Field "{{#label}}" is not allowed',
    }),
};

/* ══════════════════════════════════════════════
   Export validation middleware functions
   ══════════════════════════════════════════════ */

export const createBookingValidation = () =>
  validate(createBookingSchema, { context: true }, { abortEarly: false });

export const listBookingsValidation = () =>
  validate(listBookingsSchema, { context: true }, { abortEarly: false });

export const upcomingBookingsValidation = () =>
  validate(upcomingBookingsSchema, { context: true }, { abortEarly: false });

export const getBookingByIdValidation = () =>
  validate(getBookingByIdSchema, { context: true }, { abortEarly: false });

export const confirmBookingValidation = () =>
  validate(confirmBookingSchema, { context: true }, { abortEarly: false });

export const declineBookingValidation = () =>
  validate(declineBookingSchema, { context: true }, { abortEarly: false });

export const cancelBookingValidation = () =>
  validate(cancelBookingSchema, { context: true }, { abortEarly: false });

export const completeBookingValidation = () =>
  validate(completeBookingSchema, { context: true }, { abortEarly: false });

export const noShowBookingValidation = () =>
  validate(noShowBookingSchema, { context: true }, { abortEarly: false });

export const flagBookingValidation = () =>
  validate(flagBookingSchema, { context: true }, { abortEarly: false });
