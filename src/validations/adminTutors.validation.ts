import { Joi, validate } from "express-validation";

/* ── GET /api/admin-tutors ── */

const getAdminTutorsSchema = {
  query: Joi.object({
    page: Joi.string().optional(),
    limit: Joi.string().optional(),
    search: Joi.string().optional().allow(""),
    status: Joi.string()
      .valid(
        "all",
        "active",
        "inactive",
        "pending_approval",
        "rejected",
        "banned",
      )
      .optional(),
    sort: Joi.string()
      .valid("newest", "name", "earned", "rating", "lessons", "students")
      .optional(),
  })
    .unknown(false)
    .messages({
      "object.unknown": 'Query parameter "{{#label}}" is not supported',
    }),
};

export const getAdminTutorsValidation = () =>
  validate(getAdminTutorsSchema, { context: true }, { abortEarly: false });

/* ── PATCH /api/admin-tutors/:id/status ── */

const updateTutorStatusSchema = {
  params: Joi.object({
    id: Joi.string().required().messages({
      "any.required": "Tutor ID is required",
    }),
  }),
  body: Joi.object({
    status: Joi.string()
      .valid("active", "inactive", "pending_approval", "rejected", "banned")
      .required()
      .messages({
        "any.required": "Status is required",
        "any.only":
          "Status must be active, inactive, pending_approval, rejected, or banned",
      }),
    reason: Joi.string().optional().allow(""),
  }),
};

export const updateTutorStatusValidation = () =>
  validate(updateTutorStatusSchema, { context: true }, { abortEarly: false });
