import { Joi, validate } from "express-validation";
import { Types } from "mongoose";

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

export const listTeachersValidation = () =>
  validate(
    {
      query: Joi.object({
        page: Joi.number().integer().min(1).optional(),
        limit: Joi.number().integer().min(1).max(100).optional(),
        search: Joi.string().trim().optional().allow(""),
        approvedOnly: Joi.boolean().optional(),
      }),
    },
    { context: true },
    { abortEarly: false },
  );

export const tutorIdParamValidation = () =>
  validate(
    { params: Joi.object({ tutorId: objectId.required() }) },
    { context: true },
    { abortEarly: false },
  );

export const approveTeacherValidation = () =>
  validate(
    {
      params: Joi.object({ tutorId: objectId.required() }),
      body: Joi.object({
        esolQualificationType: Joi.string()
          .valid("CELTA", "DELTA", "CertTESOL", "DipTESOL", "PGCE", "other")
          .required()
          .messages({
            "any.only":
              "Qualification type must be one of: CELTA, DELTA, CertTESOL, DipTESOL, PGCE, other",
            "any.required": "Qualification type is required",
          }),
        esolQualificationUrl: Joi.string().uri().optional().allow("").messages({
          "string.uri": "Qualification URL must be a valid URL",
        }),
        dbsCheckStatus: Joi.string()
          .valid("pending", "clear", "flagged", "expired")
          .optional(),
        esolTeacherNotes: Joi.string().trim().optional().allow(""),
      }),
    },
    { context: true },
    { abortEarly: false },
  );

export const updateQualificationsValidation = () =>
  validate(
    {
      params: Joi.object({ tutorId: objectId.required() }),
      body: Joi.object({
        esolQualificationType: Joi.string()
          .valid("CELTA", "DELTA", "CertTESOL", "DipTESOL", "PGCE", "other")
          .optional(),
        esolQualificationUrl: Joi.string().uri().optional().allow("").messages({
          "string.uri": "Qualification URL must be a valid URL",
        }),
        dbsCheckStatus: Joi.string()
          .valid("pending", "clear", "flagged", "expired")
          .optional(),
        esolTeacherNotes: Joi.string().trim().optional().allow(""),
      }).min(1),
    },
    { context: true },
    { abortEarly: false },
  );

/* ── ESOL Teacher Application (POST /api/esol/teachers/apply) ─────── */

export const applyEsolValidation = () =>
  validate(
    {
      body: Joi.object({
        qualification_type: Joi.string()
          .valid("CELTA", "DELTA", "CertTESOL", "DipTESOL", "PGCE", "other")
          .required()
          .messages({
            "any.only":
              "Qualification type must be one of: CELTA, DELTA, CertTESOL, DipTESOL, PGCE, other",
            "any.required": "Qualification type is required",
          }),
        qualification_document_url: Joi.string().uri().required().messages({
          "string.uri": "Qualification document URL must be a valid URL",
          "any.required":
            "Qualification document URL is required — upload a copy of your certificate",
        }),
        dbs_check_reference: Joi.string()
          .trim()
          .min(4)
          .max(50)
          .required()
          .messages({
            "string.min": "DBS check reference looks too short",
            "any.required":
              "DBS check reference number is required (12-digit number from your DBS certificate)",
          }),
        esol_experience_description: Joi.string()
          .trim()
          .min(20)
          .max(2000)
          .required()
          .messages({
            "string.min":
              "Describe your ESOL teaching experience in at least 20 characters",
            "string.max":
              "ESOL experience description must be 2000 characters or fewer",
            "any.required": "ESOL experience description is required",
          }),
      }),
    },
    { context: true },
    { abortEarly: false },
  );

/* ── ESOL Teacher Rejection (PATCH /api/admin/users/:id/reject-esol-teacher) ── */

export const rejectTeacherValidation = () =>
  validate(
    {
      params: Joi.object({ id: objectId.required() }),
      body: Joi.object({
        reason: Joi.string().trim().min(10).max(1000).required().messages({
          "string.min":
            "Rejection reason must be at least 10 characters — the teacher receives this verbatim",
          "any.required": "Rejection reason is required",
        }),
      }),
    },
    { context: true },
    { abortEarly: false },
  );

/* ── ESOL Teacher Approval via admin route (PATCH /api/admin/users/:id/approve-esol-teacher) ── */

export const adminApproveEsolValidation = () =>
  validate(
    {
      params: Joi.object({ id: objectId.required() }),
      body: Joi.object({
        notes: Joi.string().trim().max(1000).optional().allow(""),
      }).optional(),
    },
    { context: true },
    { abortEarly: false },
  );
