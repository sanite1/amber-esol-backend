import { Joi, validate } from "express-validation";
import { Types } from "mongoose";

/* ── Helper: ObjectId validator ── */

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

/* ══════════════════════════════════════════════
   Schemas
   ══════════════════════════════════════════════ */

/* ── GET /conversations ── */

const listConversationsSchema = {
  query: Joi.object({
    page: Joi.string().optional(),
    limit: Joi.string().optional(),
    search: Joi.string().optional().allow(""),
    archived: Joi.string().valid("true", "false").optional().messages({
      "any.only": 'Archived must be "true" or "false"',
    }),
  })
    .unknown(false)
    .messages({
      "object.unknown": 'Query parameter "{{#label}}" is not supported',
    }),
};

/* ── POST /conversations ── */

const startConversationSchema = {
  body: Joi.object({
    participantId: objectId.required().messages({
      "any.required": "Participant ID is required",
      "any.invalid": "Participant ID must be a valid ID",
    }),
  })
    .unknown(false)
    .messages({
      "object.unknown": 'Field "{{#label}}" is not allowed',
    }),
};

/* ── GET /conversations/:id/messages ── */

const listMessagesSchema = {
  params: Joi.object({
    id: objectId.required().messages({
      "any.required": "Conversation ID is required",
      "any.invalid": "Conversation ID must be a valid ID",
    }),
  }),
  query: Joi.object({
    page: Joi.string().optional(),
    limit: Joi.string().optional(),
    before: Joi.string().isoDate().optional().messages({
      "string.isoDate": '"before" must be a valid ISO date',
    }),
  })
    .unknown(false)
    .messages({
      "object.unknown": 'Query parameter "{{#label}}" is not supported',
    }),
};

/* ── POST /conversations/:id/messages ── */

const sendMessageSchema = {
  params: Joi.object({
    id: objectId.required().messages({
      "any.required": "Conversation ID is required",
      "any.invalid": "Conversation ID must be a valid ID",
    }),
  }),
  body: Joi.object({
    content: Joi.string().trim().min(1).max(5000).required().messages({
      "string.base": "Message content must be a string",
      "string.empty": "Message content is required",
      "string.min": "Message cannot be empty",
      "string.max": "Message cannot exceed 5000 characters",
      "any.required": "Message content is required",
    }),
    type: Joi.string().valid("text").optional().default("text").messages({
      "any.only": "Type must be text (use /file endpoint for files)",
    }),
  })
    .unknown(false)
    .messages({
      "object.unknown": 'Field "{{#label}}" is not allowed',
    }),
};

/* ── POST /conversations/:id/messages/file ── */

const sendFileMessageSchema = {
  params: Joi.object({
    id: objectId.required().messages({
      "any.required": "Conversation ID is required",
      "any.invalid": "Conversation ID must be a valid ID",
    }),
  }),
};

/* ── Conversation ID param only (read, pin, mute, archive) ── */

const conversationIdSchema = {
  params: Joi.object({
    id: objectId.required().messages({
      "any.required": "Conversation ID is required",
      "any.invalid": "Conversation ID must be a valid ID",
    }),
  }),
};

/* ══════════════════════════════════════════════
   Exports
   ══════════════════════════════════════════════ */

export const listConversationsValidation = () =>
  validate(listConversationsSchema, { context: true }, { abortEarly: false });

export const startConversationValidation = () =>
  validate(startConversationSchema, { context: true }, { abortEarly: false });

export const listMessagesValidation = () =>
  validate(listMessagesSchema, { context: true }, { abortEarly: false });

export const sendMessageValidation = () =>
  validate(sendMessageSchema, { context: true }, { abortEarly: false });

export const sendFileMessageValidation = () =>
  validate(sendFileMessageSchema, { context: true }, { abortEarly: false });

export const conversationIdValidation = () =>
  validate(conversationIdSchema, { context: true }, { abortEarly: false });
