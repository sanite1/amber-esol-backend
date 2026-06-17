import { Joi, validate } from "express-validation";

/**
 * POST /api/esol/register body validation — brief Function 2 To-Do 2.
 *
 * Every ESOL learner field that drives an ILR or RARPA outcome is
 * validated at the gate. Per the brief:
 *   - `lldd_health_prob` must NEVER default to 2 — it must be explicitly
 *     supplied or the request fails. Defaulting would silently fill the
 *     ILR LLDDHealthProb field with "no disability" for learners who
 *     didn't answer, biasing the cohort's reported support needs.
 *   - `sex` is ILR-numeric (1 = Male, 2 = Female) — no other values are
 *     valid for ILR submission.
 *   - Minimum age 16 — ESOL ASF eligibility floor.
 *   - `l1_language` is the locked MVP set; Tigrinya is excluded.
 *   - `postcode_prior` checked against a loose UK regex; postcode router
 *     does the authoritative lookup downstream.
 *   - `employment_status` is the brief Function 3 enum (string codes,
 *     not raw ILR numeric codes — the export-time mapper converts).
 *
 * Strict body shape: `unknown(false)` rejects any extra field so the
 * placeholder-email + random-password generation in the service can't be
 * subverted by sneaking `email`-with-empty-string or similar values.
 */

// Minimum age 16. Accepts YYYY-MM-DD. Returns helpers.error if too young.
const dobAt16Plus = (value: string, helpers: any) => {
  const dob = new Date(value);
  if (Number.isNaN(dob.getTime())) {
    return helpers.error("any.invalid");
  }
  const now = new Date();
  const sixteenthBirthday = new Date(
    dob.getFullYear() + 16,
    dob.getMonth(),
    dob.getDate(),
  );
  if (sixteenthBirthday > now) {
    return helpers.error("any.too_young");
  }
  return value;
};

// Loose UK postcode — handles standard mainland format. Edge cases
// (Crown Dependencies, BFPO) won't match here; the PostcodeRouter will
// then return null and the registration sets funding_status = manual_review.
const UK_POSTCODE_REGEX = /^[A-Z]{1,2}[0-9][A-Z0-9]?\s*[0-9][A-Z]{2}$/i;

const L1_LANGUAGES = [
  // ── MVP (AI Tutor Brief §3): Arabic, Cantonese, Turkish, English ──
  "arabic",
  "cantonese",
  "turkish",
  "english",
  // ── Deferred — still ACCEPTED (so existing learners and the
  //    teacher-matching language data don't break), but the learner
  //    picker no longer offers them; revive by re-listing in the
  //    frontend SELECTABLE_LANGUAGES / MVP_LEARNER_LANGUAGES gates. ──
  "somali",
  "dari",
  "pashto",
  "bengali",
  "urdu",
];

const EMPLOYMENT_STATUSES = [
  "unemployed",
  "employed",
  "self_employed",
  "not_in_labour_market",
];

export const esolRegisterValidation = () =>
  validate(
    {
      body: Joi.object({
        token: Joi.string().trim().required().messages({
          "any.required": "Referral token is required",
        }),

        firstname: Joi.string().trim().min(1).max(80).required().messages({
          "any.required": "First name is required",
        }),
        lastname: Joi.string().trim().min(1).max(80).required().messages({
          "any.required": "Last name is required",
        }),

        // Optional. Service generates a placeholder if absent.
        email: Joi.string().email().lowercase().optional().messages({
          "string.email": "Email must be a valid email address",
        }),

        date_of_birth: Joi.string()
          .pattern(/^\d{4}-\d{2}-\d{2}$/)
          .custom(dobAt16Plus)
          .required()
          .messages({
            "any.required": "Date of birth is required",
            "string.pattern.base": "date_of_birth must be in YYYY-MM-DD format",
            "any.invalid": "date_of_birth is not a valid date",
            "any.too_young":
              "Learner must be 16 or older to enrol on ESOL provision",
          }),

        nationality: Joi.string().trim().min(1).max(80).required().messages({
          "any.required": "Nationality is required",
        }),

        // ILR-numeric sex. Brief is explicit: 1 (Male) or 2 (Female).
        sex: Joi.number().valid(1, 2).required().messages({
          "any.only": "sex must be 1 (Male) or 2 (Female)",
          "any.required": "sex is required",
        }),

        ethnicity: Joi.string().trim().max(80).optional().allow(""),

        // CRITICAL: must be explicitly provided. 1=has LLDD, 2=does not,
        // 9=not provided. The brief calls out by name that defaulting to
        // 2 is a compliance failure.
        lldd_health_prob: Joi.number().valid(1, 2, 9).required().messages({
          "any.required":
            "lldd_health_prob is required — must be explicitly recorded, not defaulted",
          "any.only":
            "lldd_health_prob must be 1 (has LLDD), 2 (does not), or 9 (not provided)",
        }),

        employment_status: Joi.string()
          .valid(...EMPLOYMENT_STATUSES)
          .required()
          .messages({
            "any.only": `employment_status must be one of: ${EMPLOYMENT_STATUSES.join(", ")}`,
            "any.required": "employment_status is required",
          }),

        l1_language: Joi.string()
          .lowercase()
          .valid(...L1_LANGUAGES)
          .required()
          .messages({
            "any.only": `l1_language must be one of: ${L1_LANGUAGES.join(", ")}`,
            "any.required": "l1_language is required",
          }),

        postcode_prior: Joi.string()
          .trim()
          .pattern(UK_POSTCODE_REGEX)
          .required()
          .messages({
            "any.required": "postcode_prior is required",
            "string.pattern.base":
              "postcode_prior must be a valid UK postcode (e.g. M1 1AE)",
          }),
      }).unknown(false),
    },
    { context: true },
    { abortEarly: false },
  );
