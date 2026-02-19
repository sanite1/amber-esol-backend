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

/* ══════════════════════════════════════════════
   Schemas
   ══════════════════════════════════════════════ */

/* ── POST /reviews ── */

const createReviewSchema = {
  body: Joi.object({
    bookingId: objectId.required().messages({
      "any.required": "Booking ID is required",
      "any.invalid": "Booking ID must be a valid ID",
    }),
    rating: Joi.number().integer().min(1).max(5).required().messages({
      "number.base": "Rating must be a number",
      "number.integer": "Rating must be a whole number",
      "number.min": "Rating must be at least 1",
      "number.max": "Rating cannot exceed 5",
      "any.required": "Rating is required",
    }),
    comment: Joi.string().trim().min(10).max(1000).required().messages({
      "string.base": "Comment must be a string",
      "string.empty": "Comment is required",
      "string.min": "Comment must be at least 10 characters",
      "string.max": "Comment cannot exceed 1000 characters",
      "any.required": "Comment is required",
    }),
  })
    .unknown(false)
    .messages({
      "object.unknown": 'Field "{{#label}}" is not allowed',
    }),
};

/* ── GET /reviews/tutor/:tutorId ── */

const getTutorReviewsSchema = {
  params: Joi.object({
    tutorId: objectId.required().messages({
      "any.required": "Tutor ID is required",
      "any.invalid": "Tutor ID must be a valid ID",
    }),
  }),
  query: Joi.object({
    page: Joi.string().optional(),
    limit: Joi.string().optional(),
    rating: Joi.string().valid("1", "2", "3", "4", "5").optional().messages({
      "any.only": "Rating filter must be 1, 2, 3, 4, or 5",
    }),
    sort: Joi.string()
      .valid("newest", "oldest", "rating_high", "rating_low", "most_helpful")
      .optional()
      .messages({
        "any.only":
          "Sort must be one of: newest, oldest, rating_high, rating_low, most_helpful",
      }),
  })
    .unknown(false)
    .messages({
      "object.unknown": 'Query parameter "{{#label}}" is not supported',
    }),
};

/* ── GET /reviews/me ── */

const getMyReviewsSchema = {
  query: Joi.object({
    page: Joi.string().optional(),
    limit: Joi.string().optional(),
    sort: Joi.string()
      .valid("newest", "oldest", "rating_high", "rating_low")
      .optional(),
  })
    .unknown(false)
    .messages({
      "object.unknown": 'Query parameter "{{#label}}" is not supported',
    }),
};

/* ── PATCH /reviews/:id ── */

const updateReviewSchema = {
  params: Joi.object({
    id: objectId.required().messages({
      "any.required": "Review ID is required",
      "any.invalid": "Review ID must be a valid ID",
    }),
  }),
  body: Joi.object({
    rating: Joi.number().integer().min(1).max(5).optional().messages({
      "number.base": "Rating must be a number",
      "number.integer": "Rating must be a whole number",
      "number.min": "Rating must be at least 1",
      "number.max": "Rating cannot exceed 5",
    }),
    comment: Joi.string().trim().min(10).max(1000).optional().messages({
      "string.base": "Comment must be a string",
      "string.min": "Comment must be at least 10 characters",
      "string.max": "Comment cannot exceed 1000 characters",
    }),
  })
    .min(1)
    .unknown(false)
    .messages({
      "object.unknown": 'Field "{{#label}}" is not allowed',
      "object.min": "At least one field (rating or comment) must be provided",
    }),
};

/* ── DELETE /reviews/:id ── */

const deleteReviewSchema = {
  params: Joi.object({
    id: objectId.required().messages({
      "any.required": "Review ID is required",
    }),
  }),
};

/* ── POST /reviews/:id/reply ── */

const addReplySchema = {
  params: Joi.object({
    id: objectId.required(),
  }),
  body: Joi.object({
    text: Joi.string().trim().min(5).max(1000).required().messages({
      "string.base": "Reply text must be a string",
      "string.empty": "Reply text is required",
      "string.min": "Reply must be at least 5 characters",
      "string.max": "Reply cannot exceed 1000 characters",
      "any.required": "Reply text is required",
    }),
  })
    .unknown(false)
    .messages({
      "object.unknown": 'Field "{{#label}}" is not allowed',
    }),
};

/* ── PATCH /reviews/:id/reply ── */

const updateReplySchema = {
  params: Joi.object({
    id: objectId.required(),
  }),
  body: Joi.object({
    text: Joi.string().trim().min(5).max(1000).required().messages({
      "string.base": "Reply text must be a string",
      "string.empty": "Reply text is required",
      "string.min": "Reply must be at least 5 characters",
      "string.max": "Reply cannot exceed 1000 characters",
      "any.required": "Reply text is required",
    }),
  })
    .unknown(false)
    .messages({
      "object.unknown": 'Field "{{#label}}" is not allowed',
    }),
};

/* ── DELETE /reviews/:id/reply ── */

const deleteReplySchema = {
  params: Joi.object({
    id: objectId.required(),
  }),
};

/* ── POST /reviews/:id/report ── */

const reportReviewSchema = {
  params: Joi.object({
    id: objectId.required(),
  }),
  body: Joi.object({
    reason: Joi.string().trim().min(10).max(500).required().messages({
      "string.base": "Reason must be a string",
      "string.empty": "Report reason is required",
      "string.min": "Reason must be at least 10 characters",
      "string.max": "Reason cannot exceed 500 characters",
      "any.required": "Report reason is required",
    }),
  })
    .unknown(false)
    .messages({
      "object.unknown": 'Field "{{#label}}" is not allowed',
    }),
};

/* ── POST /reviews/:id/helpful ── */

const helpfulReviewSchema = {
  params: Joi.object({
    id: objectId.required(),
  }),
};

/* ── GET /reviews/stats/:tutorId ── */

const reviewStatsSchema = {
  params: Joi.object({
    tutorId: objectId.required().messages({
      "any.required": "Tutor ID is required",
      "any.invalid": "Tutor ID must be a valid ID",
    }),
  }),
};

/* ── GET /admin/reviews ── */

const adminListReviewsSchema = {
  query: Joi.object({
    page: Joi.string().optional(),
    limit: Joi.string().optional(),
    status: Joi.string()
      .valid("published", "hidden", "removed")
      .optional()
      .messages({
        "any.only": "Status must be one of: published, hidden, removed",
      }),
    reported: Joi.string().valid("true", "false").optional().messages({
      "any.only": 'Reported must be "true" or "false"',
    }),
    sort: Joi.string()
      .valid("newest", "oldest", "rating_high", "rating_low", "most_reported")
      .optional(),
    search: Joi.string().optional().allow(""),
  })
    .unknown(false)
    .messages({
      "object.unknown": 'Query parameter "{{#label}}" is not supported',
    }),
};

/* ── Admin actions (hide, unhide, remove, restore) ── */

const adminReviewActionSchema = {
  params: Joi.object({
    id: objectId.required(),
  }),
  body: Joi.object({
    reason: Joi.string().optional().allow("").max(500),
  })
    .unknown(false)
    .messages({
      "object.unknown": 'Field "{{#label}}" is not allowed',
    }),
};

/* ── Admin report action ── */

const adminReportActionSchema = {
  params: Joi.object({
    id: objectId.required(),
    reportId: objectId.required().messages({
      "any.required": "Report ID is required",
      "any.invalid": "Report ID must be a valid ID",
    }),
  }),
  body: Joi.object({
    status: Joi.string().valid("reviewed", "dismissed").required().messages({
      "any.only": 'Status must be either "reviewed" or "dismissed"',
      "any.required": "Report status is required",
    }),
  })
    .unknown(false)
    .messages({
      "object.unknown": 'Field "{{#label}}" is not allowed',
    }),
};

/* ══════════════════════════════════════════════
   Exports
   ══════════════════════════════════════════════ */

export const createReviewValidation = () =>
  validate(createReviewSchema, { context: true }, { abortEarly: false });

export const getTutorReviewsValidation = () =>
  validate(getTutorReviewsSchema, { context: true }, { abortEarly: false });

export const getMyReviewsValidation = () =>
  validate(getMyReviewsSchema, { context: true }, { abortEarly: false });

export const updateReviewValidation = () =>
  validate(updateReviewSchema, { context: true }, { abortEarly: false });

export const deleteReviewValidation = () =>
  validate(deleteReviewSchema, { context: true }, { abortEarly: false });

export const addReplyValidation = () =>
  validate(addReplySchema, { context: true }, { abortEarly: false });

export const updateReplyValidation = () =>
  validate(updateReplySchema, { context: true }, { abortEarly: false });

export const deleteReplyValidation = () =>
  validate(deleteReplySchema, { context: true }, { abortEarly: false });

export const reportReviewValidation = () =>
  validate(reportReviewSchema, { context: true }, { abortEarly: false });

export const helpfulReviewValidation = () =>
  validate(helpfulReviewSchema, { context: true }, { abortEarly: false });

export const reviewStatsValidation = () =>
  validate(reviewStatsSchema, { context: true }, { abortEarly: false });

export const adminListReviewsValidation = () =>
  validate(adminListReviewsSchema, { context: true }, { abortEarly: false });

export const adminReviewActionValidation = () =>
  validate(adminReviewActionSchema, { context: true }, { abortEarly: false });

export const adminReportActionValidation = () =>
  validate(adminReportActionSchema, { context: true }, { abortEarly: false });
