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
    { abortEarly: false }
  );

export const tutorIdParamValidation = () =>
  validate(
    { params: Joi.object({ tutorId: objectId.required() }) },
    { context: true },
    { abortEarly: false }
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
    { abortEarly: false }
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
    { abortEarly: false }
  );
