import { Joi, validate } from "express-validation";

/* ── GET /api/admin-students ── */

const getAdminStudentsSchema = {
  query: Joi.object({
    page: Joi.string().optional(),
    limit: Joi.string().optional(),
    search: Joi.string().optional().allow(""),
    status: Joi.string()
      .valid("all", "active", "inactive", "banned")
      .optional(),
    sort: Joi.string()
      .valid("newest", "name", "spent", "lessons", "recent")
      .optional(),
  })
    .unknown(false)
    .messages({
      "object.unknown": 'Query parameter "{{#label}}" is not supported',
    }),
};

export const getAdminStudentsValidation = () =>
  validate(getAdminStudentsSchema, { context: true }, { abortEarly: false });

/* ── PATCH /api/admin-students/:id/status ── */

const updateStudentStatusSchema = {
  params: Joi.object({
    id: Joi.string().required().messages({
      "any.required": "Student ID is required",
    }),
  }),
  body: Joi.object({
    status: Joi.string()
      .valid("active", "inactive", "banned")
      .required()
      .messages({
        "any.required": "Status is required",
        "any.only": "Status must be active, inactive, or banned",
      }),
    reason: Joi.string().optional().allow(""),
  }),
};

export const updateStudentStatusValidation = () =>
  validate(updateStudentStatusSchema, { context: true }, { abortEarly: false });
