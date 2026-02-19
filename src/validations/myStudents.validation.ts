import Joi from "joi";
import { validate } from "express-validation";
import mongoose from "mongoose";

/* ── Custom ObjectId validator ── */
const objectId = Joi.string().custom((value, helpers) => {
  if (!mongoose.Types.ObjectId.isValid(value)) {
    return helpers.error("any.invalid");
  }
  return value;
}, "ObjectId validation");

/* ══════════════════════════════════════════════
   GET /my-students
   ══════════════════════════════════════════════ */
const listMyStudentsSchema = {
  query: Joi.object({
    page: Joi.string().pattern(/^\d+$/).optional(),
    limit: Joi.string().pattern(/^\d+$/).optional(),
    filter: Joi.string()
      .valid("all", "active", "trial", "inactive")
      .optional()
      .messages({
        "any.only": "Filter must be one of: all, active, trial, inactive",
      }),
    sort: Joi.string()
      .valid("recent", "name", "lessons", "joined")
      .optional()
      .messages({
        "any.only": "Sort must be one of: recent, name, lessons, joined",
      }),
    search: Joi.string().optional().allow(""),
  }).unknown(false),
};

export const listMyStudentsValidation = validate(
  listMyStudentsSchema,
  { context: true },
  { abortEarly: false }
);

/* ══════════════════════════════════════════════
   GET /my-students/:studentId
   ══════════════════════════════════════════════ */
const myStudentDetailSchema = {
  params: Joi.object({
    studentId: objectId.required().messages({
      "any.invalid": "Invalid student ID",
      "any.required": "Student ID is required",
    }),
  }).unknown(false),
};

export const myStudentDetailValidation = validate(
  myStudentDetailSchema,
  { context: true },
  { abortEarly: false }
);

/* ══════════════════════════════════════════════
   PATCH /my-students/:studentId/notes
   ══════════════════════════════════════════════ */
const updateStudentNotesSchema = {
  params: Joi.object({
    studentId: objectId.required().messages({
      "any.invalid": "Invalid student ID",
      "any.required": "Student ID is required",
    }),
  }).unknown(false),
  body: Joi.object({
    notes: Joi.string().max(1000).required().allow("").messages({
      "string.max": "Notes cannot exceed 1000 characters",
      "any.required": "Notes field is required",
    }),
  }).unknown(false),
};

export const updateStudentNotesValidation = validate(
  updateStudentNotesSchema,
  { context: true },
  { abortEarly: false }
);
