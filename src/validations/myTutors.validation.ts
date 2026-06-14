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
   GET /my-tutors
   ══════════════════════════════════════════════ */
const listMyTutorsSchema = {
  query: Joi.object({
    page: Joi.string().pattern(/^\d+$/).optional(),
    limit: Joi.string().pattern(/^\d+$/).optional(),
    search: Joi.string().max(100).optional().allow(""),
    filter: Joi.string()
      .valid("all", "active", "past", "favourites")
      .optional(),
    sort: Joi.string().valid("recent", "name", "lessons", "rating").optional(),
  }).unknown(false),
};

export const listMyTutorsValidation = validate(
  listMyTutorsSchema,
  { context: true },
  { abortEarly: false },
);

/* ══════════════════════════════════════════════
   POST /my-tutors/:tutorId/favourite
   ══════════════════════════════════════════════ */
const toggleFavouriteSchema = {
  params: Joi.object({
    tutorId: objectId.required().messages({
      "any.invalid": "Invalid tutor ID",
    }),
  }).unknown(false),
};

export const toggleFavouriteValidation = validate(
  toggleFavouriteSchema,
  { context: true },
  { abortEarly: false },
);

/* ══════════════════════════════════════════════
   GET /my-tutors/:tutorId
   ══════════════════════════════════════════════ */
const getMyTutorDetailSchema = {
  params: Joi.object({
    tutorId: objectId.required().messages({
      "any.invalid": "Invalid tutor ID",
    }),
  }).unknown(false),
};

export const getMyTutorDetailValidation = validate(
  getMyTutorDetailSchema,
  { context: true },
  { abortEarly: false },
);
