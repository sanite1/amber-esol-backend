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

const addressSchema = Joi.object({
  street: Joi.string().optional().allow(""),
  city: Joi.string().optional().allow(""),
  state: Joi.string().optional().allow(""),
  postcode: Joi.string().optional().allow(""),
  country: Joi.string().optional().allow(""),
}).optional();

export const provisionOrgValidation = () =>
  validate(
    {
      body: Joi.object({
        name: Joi.string().trim().min(2).max(120).required().messages({
          "string.min": "Organisation name must be at least 2 characters",
          "any.required": "Organisation name is required",
        }),
        contactEmail: Joi.string().email().lowercase().required().messages({
          "string.email": "Contact email must be a valid email address",
          "any.required": "Contact email is required",
        }),
        contactName: Joi.string().trim().min(2).max(100).required().messages({
          "any.required": "Contact name is required",
        }),
        phoneNumber: Joi.string().trim().optional().allow(""),
        address: addressSchema,
        contractStart: Joi.string().isoDate().optional().messages({
          "string.isoDate": "Contract start must be a valid date (ISO 8601)",
        }),
        contractEnd: Joi.string().isoDate().optional().messages({
          "string.isoDate": "Contract end must be a valid date (ISO 8601)",
        }),
        paymentModel: Joi.string()
          .valid("invoiced", "stripe")
          .required()
          .messages({
            "any.only": "Payment model must be invoiced or stripe",
            "any.required": "Payment model is required",
          }),
        invoiceCycle: Joi.string()
          .valid("monthly", "quarterly", "annual")
          .required()
          .messages({
            "any.only": "Invoice cycle must be monthly, quarterly or annual",
            "any.required": "Invoice cycle is required",
          }),
        maxLearners: Joi.number().integer().min(1).optional(),
        ilrProviderRef: Joi.string().trim().optional().allow(""),
        adminFirstname: Joi.string().trim().min(1).max(50).required().messages({
          "any.required": "Admin first name is required",
        }),
        adminLastname: Joi.string().trim().min(1).max(50).required().messages({
          "any.required": "Admin last name is required",
        }),
        adminEmail: Joi.string().email().lowercase().required().messages({
          "string.email": "Admin email must be a valid email address",
          "any.required": "Admin email is required",
        }),
        adminPhoneNumber: Joi.string().trim().required().messages({
          "any.required": "Admin phone number is required",
        }),
        adminPassword: Joi.string().min(8).required().messages({
          "string.min": "Admin password must be at least 8 characters",
          "any.required": "Admin password is required",
        }),
      }),
    },
    { context: true },
    { abortEarly: false }
  );

export const updateOrgValidation = () =>
  validate(
    {
      params: Joi.object({ orgId: objectId.required() }),
      body: Joi.object({
        name: Joi.string().trim().min(2).max(120).optional(),
        contactEmail: Joi.string().email().lowercase().optional(),
        contactName: Joi.string().trim().min(2).max(100).optional(),
        phoneNumber: Joi.string().trim().optional().allow(""),
        address: addressSchema,
        contractStart: Joi.string().isoDate().optional(),
        contractEnd: Joi.string().isoDate().optional(),
        paymentModel: Joi.string().valid("invoiced", "stripe").optional(),
        invoiceCycle: Joi.string()
          .valid("monthly", "quarterly", "annual")
          .optional(),
        maxLearners: Joi.number().integer().min(1).optional(),
        ilrProviderRef: Joi.string().trim().optional().allow(""),
      }).min(1),
    },
    { context: true },
    { abortEarly: false }
  );

export const updateOrgStatusValidation = () =>
  validate(
    {
      params: Joi.object({ orgId: objectId.required() }),
      body: Joi.object({
        isActive: Joi.boolean().required().messages({
          "any.required": "isActive is required",
        }),
      }),
    },
    { context: true },
    { abortEarly: false }
  );

export const getOrgValidation = () =>
  validate(
    { params: Joi.object({ orgId: objectId.required() }) },
    { context: true },
    { abortEarly: false }
  );

export const listOrgsValidation = () =>
  validate(
    {
      query: Joi.object({
        page: Joi.number().integer().min(1).optional(),
        limit: Joi.number().integer().min(1).max(100).optional(),
        search: Joi.string().trim().optional().allow(""),
        isActive: Joi.boolean().optional(),
      }),
    },
    { context: true },
    { abortEarly: false }
  );
