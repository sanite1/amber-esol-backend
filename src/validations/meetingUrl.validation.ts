import { Joi, validate } from "express-validation";

const updateMeetingUrlSchema = {
  params: Joi.object({
    id: Joi.string().required().messages({
      "any.required": "Booking ID is required",
    }),
  }),
  body: Joi.object({
    meetingUrl: Joi.string().uri().required().messages({
      "any.required": "Meeting URL is required",
      "any.only": "Please provide a valid URL (e.g. https://zoom.us/j/...)",
    }),
    reason: Joi.string().optional().allow(""),
  }),
};

export const updateMeetingUrlValidation = () =>
  validate(updateMeetingUrlSchema, { context: true }, { abortEarly: false });
