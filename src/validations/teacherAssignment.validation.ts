/**
 * Joi validation for the teacher-assignment endpoints — brief Final
 * Addendum §4.
 */

import { Joi, validate } from "express-validation";
import { Types } from "mongoose";

const objectIdRule = (
  value: string,
  helpers: { error: (code: string) => unknown },
) => {
  if (!Types.ObjectId.isValid(value)) return helpers.error("any.invalid");
  return value;
};

// ─────────────────────────────────────────────────────────────────────
// :teacherId param
// ─────────────────────────────────────────────────────────────────────

const teacherIdParamSchema = {
  params: Joi.object({
    teacherId: Joi.string().custom(objectIdRule, "ObjectId").required(),
  }),
};

export const teacherIdParamValidation = () =>
  validate(teacherIdParamSchema, { context: true }, { abortEarly: false });

// ─────────────────────────────────────────────────────────────────────
// PATCH /api/org-admin/learners/:learnerId/teacher body
// ─────────────────────────────────────────────────────────────────────

const assignTeacherSchema = {
  params: Joi.object({
    learnerId: Joi.string().custom(objectIdRule, "ObjectId").required(),
  }),
  body: Joi.object({
    // null is the explicit "unassign" path — Joi needs allow(null) on
    // the string rule to accept it without falling into `required`.
    teacher_id: Joi.string()
      .custom(objectIdRule, "ObjectId")
      .allow(null)
      .required()
      .messages({
        "any.required": "teacher_id is required (use null to unassign)",
      }),
  }).unknown(false),
};

export const assignTeacherToLearnerValidation = () =>
  validate(assignTeacherSchema, { context: true }, { abortEarly: false });
