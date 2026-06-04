/**
 * Joi validation for the teacher pathway-override endpoint —
 * Final Addendum §9, Todo 22.6.
 *
 *   POST /api/teacher/learners/:id/pathway
 *
 * Body shape only. Semantic checks (learner assignment, scenario
 * existence + level-range match) live in the service.
 *
 * The 20-scenario ceiling on `scenario_ids` is a sanity bound — a
 * real pathway override picks 1–5 next steps; 20 is enough to
 * cover the edge case of a teacher pre-loading a longer plan, but
 * tight enough to refuse a copy-paste-the-whole-bank mishap.
 */

import { Joi, validate } from "express-validation";

const schema = {
  params: Joi.object({
    id: Joi.string()
      .pattern(/^[a-fA-F0-9]{24}$/)
      .required()
      .messages({
        "string.pattern.base": "learner id must be a 24-char ObjectId",
      }),
  }),
  body: Joi.object({
    scenario_ids: Joi.array()
      .items(
        // Scenario ids are filename slugs (e.g. "s1_gp_appointment").
        // Whitelist the character set so a path-traversal attempt
        // ("../") never reaches the disk loader in the service.
        Joi.string()
          .pattern(/^[a-z0-9_-]+$/i)
          .min(2)
          .max(80)
          .messages({
            "string.pattern.base":
              "scenario_id must contain only letters, digits, underscore, hyphen",
          }),
      )
      .min(1)
      .max(20)
      .unique()
      .required()
      .messages({
        "array.min": "scenario_ids must contain at least one id",
        "array.max": "scenario_ids must contain at most 20 ids",
        "array.unique": "scenario_ids must not contain duplicates",
      }),
  }).unknown(false),
};

export const setPathwayOverrideValidation = () =>
  validate(schema, { context: true }, { abortEarly: false });
