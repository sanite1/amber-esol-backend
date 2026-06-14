import { Joi, validate } from "express-validation";

/**
 * PATCH /api/teacher/teaching-profile body.
 *
 * Levels accept both code ("e1") and display ("Entry 1") forms — the
 * service normalises to codes. Specialisms are whitelisted again in
 * the service against TEACHER_SPECIALISMS, so this layer only shape-
 * checks. Languages are free-form display names (must match learner
 * l1Language values), capped to keep payloads sane.
 */
export const updateTeachingProfileValidation = () =>
  validate(
    {
      body: Joi.object({
        levels_taught: Joi.array()
          .items(Joi.string().trim().max(20))
          .max(10)
          .optional(),
        languages_spoken: Joi.array()
          .items(Joi.string().trim().max(50))
          .max(30)
          .optional(),
        specialisms: Joi.array()
          .items(Joi.string().trim().max(40))
          .max(10)
          .optional(),
      }),
    },
    { context: true },
    { abortEarly: false },
  );
