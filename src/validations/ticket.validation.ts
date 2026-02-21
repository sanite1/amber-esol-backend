import { Joi, validate } from "express-validation";

/* ── POST /api/tickets ── */
const createTicketSchema = {
  body: Joi.object({
    subject: Joi.string().required().max(200).messages({
      "any.required": "Subject is required",
      "string.max": "Subject must be 200 characters or less",
    }),
    category: Joi.string()
      .valid(
        "billing",
        "technical",
        "lesson_issue",
        "account",
        "report",
        "other"
      )
      .required()
      .messages({ "any.required": "Category is required" }),
    priority: Joi.string().valid("low", "medium", "high", "urgent").optional(),
    message: Joi.string().required().max(5000).messages({
      "any.required": "Message is required",
    }),
    relatedLessonId: Joi.string().optional().allow(""),
    relatedTutorId: Joi.string().optional().allow(""),
    relatedStudentId: Joi.string().optional().allow(""),
  }),
};

export const createTicketValidation = () =>
  validate(createTicketSchema, { context: true }, { abortEarly: false });

/* ── GET /api/tickets/my ── */
const getMyTicketsSchema = {
  query: Joi.object({
    page: Joi.string().optional(),
    limit: Joi.string().optional(),
    status: Joi.string().optional(),
  }).unknown(false),
};

export const getMyTicketsValidation = () =>
  validate(getMyTicketsSchema, { context: true }, { abortEarly: false });

/* ── POST /api/tickets/:id/reply or /api/tickets/admin/:id/reply ── */
const replyTicketSchema = {
  params: Joi.object({
    id: Joi.string().required(),
  }),
  body: Joi.object({
    message: Joi.string().required().max(5000).messages({
      "any.required": "Message is required",
    }),
  }),
};

export const replyTicketValidation = () =>
  validate(replyTicketSchema, { context: true }, { abortEarly: false });

/* ── GET /api/tickets/admin ── */
const getAdminTicketsSchema = {
  query: Joi.object({
    page: Joi.string().optional(),
    limit: Joi.string().optional(),
    search: Joi.string().optional().allow(""),
    status: Joi.string()
      .valid(
        "all",
        "open",
        "in_progress",
        "awaiting_user",
        "resolved",
        "closed"
      )
      .optional(),
    category: Joi.string()
      .valid(
        "all",
        "billing",
        "technical",
        "lesson_issue",
        "account",
        "report",
        "other"
      )
      .optional(),
    priority: Joi.string()
      .valid("all", "low", "medium", "high", "urgent")
      .optional(),
    submitterType: Joi.string().valid("all", "student", "tutor").optional(),
    sort: Joi.string()
      .valid("newest", "oldest", "priority_high", "last_updated")
      .optional(),
  })
    .unknown(false)
    .messages({
      "object.unknown": 'Query parameter "{{#label}}" is not supported',
    }),
};

export const getAdminTicketsValidation = () =>
  validate(getAdminTicketsSchema, { context: true }, { abortEarly: false });

/* ── PATCH /api/tickets/admin/:id/status ── */
const updateTicketStatusSchema = {
  params: Joi.object({ id: Joi.string().required() }),
  body: Joi.object({
    status: Joi.string()
      .valid("open", "in_progress", "awaiting_user", "resolved", "closed")
      .required()
      .messages({ "any.required": "Status is required" }),
  }),
};

export const updateTicketStatusValidation = () =>
  validate(updateTicketStatusSchema, { context: true }, { abortEarly: false });

/* ── PATCH /api/tickets/admin/:id/priority ── */
const updateTicketPrioritySchema = {
  params: Joi.object({ id: Joi.string().required() }),
  body: Joi.object({
    priority: Joi.string()
      .valid("low", "medium", "high", "urgent")
      .required()
      .messages({ "any.required": "Priority is required" }),
  }),
};

export const updateTicketPriorityValidation = () =>
  validate(
    updateTicketPrioritySchema,
    { context: true },
    { abortEarly: false }
  );
