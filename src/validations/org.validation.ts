import { Joi, validate } from "express-validation";
import { Types } from "mongoose";

/**
 * Validation schemas for /api/orgs — brief Function 1.
 *
 * Body field names use the brief's snake_case spec verbatim. The service
 * layer maps snake_case body fields to the schema's mixed-case storage
 * (e.g. `learner_cap` → `maxLearners` in Mongo).
 *
 * Separate from the legacy /api/esol/organisations validators, which
 * accept a richer body (contactEmail/contactName/admin*) for the
 * provisioning-with-admin flow.
 */

const objectId = Joi.string()
  .custom((value, helpers) => {
    if (!Types.ObjectId.isValid(value)) {
      return helpers.error("any.invalid");
    }
    return value;
  }, "ObjectId validation")
  .messages({
    "any.invalid": "{{#label}} must be a valid ID",
  });

const isoDate = Joi.date().iso();

/* ── POST /api/orgs ─────────────────────────────────────────────────── */

export const createOrgValidation = () =>
  validate(
    {
      body: Joi.object({
        name: Joi.string().trim().min(2).max(200).required().messages({
          "any.required": "Organisation name is required",
        }),
        type: Joi.string()
          .valid("college", "council", "charity", "employer")
          .required()
          .messages({
            "any.only":
              "Organisation type must be one of: college, council, charity, employer",
            "any.required": "Organisation type is required",
          }),
        contract_start: isoDate.optional(),
        contract_end: isoDate.optional().when("contract_start", {
          is: Joi.exist(),
          then: Joi.date().greater(Joi.ref("contract_start")).messages({
            "date.greater": "contract_end must be after contract_start",
          }),
        }),
        learner_cap: Joi.number().integer().min(0).optional(),
        monthly_fee_per_head: Joi.number().min(0).optional(),
        esol_session_rate: Joi.number().min(0).optional(),
        reporting_contact_email: Joi.string()
          .email()
          .lowercase()
          .optional()
          .allow(null),
        is_demo: Joi.boolean().optional(),
        is_employer: Joi.boolean().optional(),
        notes: Joi.string().trim().max(2000).optional().allow(""),
      }).unknown(false),
    },
    { context: true },
    { abortEarly: false }
  );

/* ── PATCH /api/orgs/:id ────────────────────────────────────────────── */

export const updateOrgValidation = () =>
  validate(
    {
      params: Joi.object({ id: objectId.required() }),
      // Per brief: only the six explicitly updatable fields. MIS fields,
      // name, type, slug, is_demo, etc. are intentionally not editable here.
      body: Joi.object({
        learner_cap: Joi.number().integer().min(0).optional(),
        monthly_fee_per_head: Joi.number().min(0).optional(),
        esol_session_rate: Joi.number().min(0).optional(),
        contract_end: isoDate.optional(),
        billing_active: Joi.boolean().optional(),
        max_learners_per_teacher: Joi.number().integer().min(1).optional(),
      })
        .min(1)
        .unknown(false)
        .messages({
          "object.min": "At least one updatable field must be provided",
          "object.unknown":
            "Field is not updatable via this endpoint. MIS fields use a separate Phase 16 route; name/type/slug/is_demo are immutable.",
        }),
    },
    { context: true },
    { abortEarly: false }
  );

/* ── GET /api/orgs/:id ──────────────────────────────────────────────── */

export const orgIdParamValidation = () =>
  validate(
    { params: Joi.object({ id: objectId.required() }) },
    { context: true },
    { abortEarly: false }
  );

/* ── GET /api/orgs ──────────────────────────────────────────────────── */

export const listOrgsValidation = () =>
  validate(
    {
      query: Joi.object({
        include_demo: Joi.boolean().optional(),
        page: Joi.number().integer().min(1).optional(),
        limit: Joi.number().integer().min(1).max(200).optional(),
        search: Joi.string().trim().optional().allow(""),
      }),
    },
    { context: true },
    { abortEarly: false }
  );

/* ── POST /api/orgs/:id/referral-link ───────────────────────────────── */

export const createReferralLinkValidation = () =>
  validate(
    {
      params: Joi.object({ id: objectId.required() }),
      // Body is optional. If absent, service defaults to org.contract_end.
      body: Joi.object({
        expires_at: isoDate.greater("now").optional().messages({
          "date.greater": "expires_at must be in the future",
        }),
      }).optional(),
    },
    { context: true },
    { abortEarly: false }
  );

/* ── GET /api/orgs/:id/referral-links ───────────────────────────────── */

export const listReferralLinksValidation = () =>
  validate(
    {
      params: Joi.object({ id: objectId.required() }),
      query: Joi.object({
        page: Joi.number().integer().min(1).optional(),
        limit: Joi.number().integer().min(1).max(200).optional(),
      }),
    },
    { context: true },
    { abortEarly: false }
  );

/* ── DELETE /api/orgs/:id/referral-links/:tokenId ───────────────────── */

export const deactivateReferralLinkValidation = () =>
  validate(
    {
      params: Joi.object({
        id: objectId.required(),
        tokenId: objectId.required(),
      }),
    },
    { context: true },
    { abortEarly: false }
  );

/* ── POST /api/orgs/:id/admin-user ──────────────────────────────────── */

export const createOrgAdminUserValidation = () =>
  validate(
    {
      params: Joi.object({ id: objectId.required() }),
      body: Joi.object({
        email: Joi.string().email().lowercase().required().messages({
          "string.email": "Email must be a valid email address",
          "any.required": "Email is required",
        }),
        firstname: Joi.string().trim().min(1).max(80).required().messages({
          "any.required": "First name is required",
        }),
        lastname: Joi.string().trim().min(1).max(80).required().messages({
          "any.required": "Last name is required",
        }),
        // Strength rules also enforced server-side by validatePassword util.
        password: Joi.string().min(8).max(200).required().messages({
          "string.min": "Password must be at least 8 characters",
          "any.required": "Password is required",
        }),
      }).unknown(false),
    },
    { context: true },
    { abortEarly: false }
  );
