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
   GET /notifications
   ══════════════════════════════════════════════ */
const listNotificationsSchema = {
  query: Joi.object({
    page: Joi.string().pattern(/^\d+$/).optional(),
    limit: Joi.string().pattern(/^\d+$/).optional(),
    read: Joi.string().valid("true", "false").optional(),
    type: Joi.string().optional(),
    sort: Joi.string().valid("newest", "oldest").optional(),
  }).unknown(false),
};

export const listNotificationsValidation = validate(
  listNotificationsSchema,
  { context: true },
  { abortEarly: false },
);

/* ══════════════════════════════════════════════
   PATCH /notifications/:id/read
   ══════════════════════════════════════════════ */
const markReadSchema = {
  params: Joi.object({
    id: objectId.required().messages({
      "any.invalid": "Invalid notification ID",
    }),
  }).unknown(false),
};

export const markReadValidation = validate(
  markReadSchema,
  { context: true },
  { abortEarly: false },
);

/* ══════════════════════════════════════════════
   PATCH /notifications/read-all
   — explicitly allow empty body/params/query
   ══════════════════════════════════════════════ */
const markAllReadSchema = {
  body: Joi.object({}).unknown(false),
};

export const markAllReadValidation = validate(
  markAllReadSchema,
  { context: true },
  { abortEarly: false },
);

/* ══════════════════════════════════════════════
   DELETE /notifications/:id
   ══════════════════════════════════════════════ */
const deleteNotificationSchema = {
  params: Joi.object({
    id: objectId.required().messages({
      "any.invalid": "Invalid notification ID",
    }),
  }).unknown(false),
};

export const deleteNotificationValidation = validate(
  deleteNotificationSchema,
  { context: true },
  { abortEarly: false },
);
