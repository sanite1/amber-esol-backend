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

export const createReferralValidation = () =>
  validate(
    {
      body: Joi.object({
        orgId: objectId.optional(),
        email: Joi.string().email().lowercase().optional().messages({
          "string.email": "Invite email must be a valid email address",
        }),
        esolLevel: Joi.string().trim().optional().allow(""),
        expiresInDays: Joi.number().integer().min(1).max(365).optional(),
      }),
    },
    { context: true },
    { abortEarly: false }
  );

export const listReferralsValidation = () =>
  validate(
    {
      query: Joi.object({
        page: Joi.number().integer().min(1).optional(),
        limit: Joi.number().integer().min(1).max(100).optional(),
        isActive: Joi.boolean().optional(),
        orgId: objectId.optional(),
      }),
    },
    { context: true },
    { abortEarly: false }
  );

export const validateTokenParamValidation = () =>
  validate(
    {
      params: Joi.object({
        token: Joi.string().trim().required().messages({
          "any.required": "Invitation token is required",
        }),
      }),
    },
    { context: true },
    { abortEarly: false }
  );

export const registerViaReferralValidation = () =>
  validate(
    {
      body: Joi.object({
        token: Joi.string().trim().required().messages({
          "any.required": "Invitation token is required",
        }),
        firstname: Joi.string().trim().min(1).max(50).required().messages({
          "any.required": "First name is required",
        }),
        lastname: Joi.string().trim().min(1).max(50).required().messages({
          "any.required": "Last name is required",
        }),
        email: Joi.string().email().lowercase().required().messages({
          "string.email": "Email must be a valid email address",
          "any.required": "Email is required",
        }),
        phoneNumber: Joi.string().trim().required().messages({
          "any.required": "Phone number is required",
        }),
        password: Joi.string().min(8).required().messages({
          "string.min": "Password must be at least 8 characters",
          "any.required": "Password is required",
        }),
        l1Language: Joi.string().trim().optional().allow(""),
        uln: Joi.string().trim().optional().allow(""),
      }),
    },
    { context: true },
    { abortEarly: false }
  );
