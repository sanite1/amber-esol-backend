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

/* ── Sub-schemas ── */

const timeBlockSchema = Joi.object({
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
    "object.unknown": "{{#label}} is not a recognised time block field",
    "any.custom": "End time must be after start time",
  });

const dayScheduleSchema = Joi.object({
  day: Joi.string()
    .valid(
      "monday",
      "tuesday",
      "wednesday",
      "thursday",
      "friday",
      "saturday",
      "sunday"
    )
    .required()
    .messages({
      "any.only":
        "Day must be one of: monday, tuesday, wednesday, thursday, friday, saturday, sunday",
      "any.required": "Day is required",
    }),
  enabled: Joi.boolean().required().messages({
    "boolean.base": "Enabled must be true or false",
    "any.required": "Enabled is required",
  }),
  blocks: Joi.array().items(timeBlockSchema).default([]).messages({
    "array.base": "Blocks must be an array",
  }),
})
  .unknown(false)
  .messages({
    "object.unknown": "{{#label}} is not a recognised schedule field",
  });

/* ══════════════════════════════════════════════
   Main schemas
   ══════════════════════════════════════════════ */

/* ── GET /availability/:tutorId ── */

const getAvailabilitySchema = {
  params: Joi.object({
    tutorId: objectId.required().messages({
      "any.invalid": "Tutor ID must be a valid ID",
      "any.required": "Tutor ID is required",
    }),
  }),
};

/* ── PUT /availability (set/replace weekly schedule) ── */

const setScheduleSchema = {
  body: Joi.object({
    weeklySchedule: Joi.array()
      .items(dayScheduleSchema)
      .length(7)
      .required()
      .messages({
        "array.base": "Weekly schedule must be an array",
        "array.length": "Weekly schedule must contain all 7 days",
        "any.required": "Weekly schedule is required",
      }),
    timezone: Joi.string().optional().messages({
      "string.base": "Timezone must be a string",
    }),
  })
    .unknown(false)
    .messages({
      "object.unknown": 'Field "{{#label}}" is not allowed',
    }),
};

/* ── PATCH /availability/settings ── */

const updateSettingsSchema = {
  body: Joi.object({
    timezone: Joi.string().optional().messages({
      "string.base": "Timezone must be a string",
    }),
    bufferMinutes: Joi.number().min(0).max(60).optional().messages({
      "number.base": "Buffer minutes must be a number",
      "number.min": "Buffer minutes cannot be negative",
      "number.max": "Buffer minutes cannot exceed 60",
    }),
    minBookingNotice: Joi.number().min(0).optional().messages({
      "number.base": "Minimum booking notice must be a number",
      "number.min": "Minimum booking notice cannot be negative",
    }),
    maxBookingAdvance: Joi.number().min(1).optional().messages({
      "number.base": "Maximum booking advance must be a number",
      "number.min": "Maximum booking advance must be at least 1 day",
    }),
  })
    .unknown(false)
    .messages({
      "object.unknown": 'Field "{{#label}}" is not allowed',
    }),
};

/* ── POST /availability/overrides ── */

const createOverrideSchema = {
  body: Joi.object({
    date: Joi.string()
      .pattern(/^\d{4}-\d{2}-\d{2}$/)
      .required()
      .messages({
        "string.pattern.base": "Date must be in YYYY-MM-DD format",
        "string.base": "Date must be a string",
        "string.empty": "Date is required",
        "any.required": "Date is required",
      }),
    type: Joi.string().valid("unavailable", "extra").required().messages({
      "any.only": 'Type must be either "unavailable" or "extra"',
      "any.required": "Type is required",
    }),
    reason: Joi.string().optional().allow("").max(200).messages({
      "string.base": "Reason must be a string",
      "string.max": "Reason cannot exceed 200 characters",
    }),
    blocks: Joi.array().items(timeBlockSchema).optional().messages({
      "array.base": "Blocks must be an array",
    }),
  })
    .custom((value, helpers) => {
      if (
        value.type === "extra" &&
        (!value.blocks || value.blocks.length === 0)
      ) {
        return helpers.error("any.custom", {
          message: "Extra availability must include at least one time block",
        });
      }
      return value;
    })
    .unknown(false)
    .messages({
      "object.unknown": 'Field "{{#label}}" is not allowed',
      "any.custom": "Extra availability must include at least one time block",
    }),
};

/* ── DELETE /availability/overrides/:id ── */

const deleteOverrideSchema = {
  params: Joi.object({
    id: objectId.required().messages({
      "any.invalid": "Override ID must be a valid ID",
      "any.required": "Override ID is required",
    }),
  }),
};

/* ── GET /availability/:tutorId/slots?date=YYYY-MM-DD ── */

const getAvailableSlotsSchema = {
  params: Joi.object({
    tutorId: objectId.required().messages({
      "any.invalid": "Tutor ID must be a valid ID",
      "any.required": "Tutor ID is required",
    }),
  }),
  query: Joi.object({
    date: Joi.string()
      .pattern(/^\d{4}-\d{2}-\d{2}$/)
      .required()
      .messages({
        "string.pattern.base": "Date must be in YYYY-MM-DD format",
        "string.base": "Date must be a string",
        "string.empty": "Date is required",
        "any.required": "Date is required",
      }),
    duration: Joi.string().optional().messages({
      "string.base": "Duration must be a string",
    }),
  })
    .unknown(false)
    .messages({
      "object.unknown": 'Query parameter "{{#label}}" is not supported',
    }),
};

/* ══════════════════════════════════════════════
   Export validation middleware functions
   ══════════════════════════════════════════════ */

export const getAvailabilityValidation = () =>
  validate(getAvailabilitySchema, { context: true }, { abortEarly: false });

export const setScheduleValidation = () =>
  validate(setScheduleSchema, { context: true }, { abortEarly: false });

export const updateSettingsValidation = () =>
  validate(updateSettingsSchema, { context: true }, { abortEarly: false });

export const createOverrideValidation = () =>
  validate(createOverrideSchema, { context: true }, { abortEarly: false });

export const deleteOverrideValidation = () =>
  validate(deleteOverrideSchema, { context: true }, { abortEarly: false });

export const getAvailableSlotsValidation = () =>
  validate(getAvailableSlotsSchema, { context: true }, { abortEarly: false });
