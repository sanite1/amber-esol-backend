import { Schema, model } from "mongoose";
import { IOrganisation } from "../interfaces/organisation.interface";

/**
 * Organisation — colleges, councils, charities, employers that purchase
 * Project Silk access for their learners.
 *
 * Field naming:
 *   - Existing camelCase fields (slug, contactEmail, contractStart, etc.)
 *     are preserved as-is from pre-Project-Silk work.
 *   - Brief Phase 1.8 + addendum fields use snake_case per the brief.
 *   - MIS fields (misType, misApiEndpoint, misApiCredentials) are camelCase
 *     specifically because the addendum spec writes them that way.
 *
 * MIS credentials: misApiCredentials stores the AES-256-encrypted blob
 * produced by `cryptr` (keyed by MIS_CREDENTIALS_KEY env var). Encryption
 * and decryption happen in the service layer (Phase 21) — never store
 * plaintext credentials in this collection.
 */

const organisationSchema = new Schema<IOrganisation>(
  {
    // ── Existing fields (preserved) ────────────────────────────────────
    name: { type: String, required: true, trim: true },
    slug: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    // contactEmail / contactName / adminUserId are optional at the schema
    // level so brief Function 1 can create an org BEFORE the org_admin user
    // exists. Existing /api/esol/organisations provisioning still requires
    // them at the API-validator layer.
    contactEmail: { type: String, default: null, lowercase: true, trim: true },
    contactName: { type: String, default: null, trim: true },
    phoneNumber: { type: String, trim: true },
    address: {
      street: { type: String },
      city: { type: String },
      state: { type: String },
      postcode: { type: String },
      country: { type: String },
    },
    logoUrl: { type: String },
    contractStart: { type: Date },
    contractEnd: { type: Date },
    paymentModel: {
      type: String,
      enum: ["invoiced", "stripe"],
      required: true,
      default: "invoiced",
    },
    invoiceCycle: {
      type: String,
      enum: ["monthly", "quarterly", "annual"],
      required: true,
      default: "monthly",
    },
    maxLearners: { type: Number },
    isActive: { type: Boolean, default: true },
    adminUserId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    referralCode: { type: String },
    ilrProviderRef: { type: String },

    // ── Brief Phase 1.8 new fields ────────────────────────────────────
    type: {
      type: String,
      enum: ["college", "council", "charity", "employer"],
      default: null,
    },
    monthly_fee_per_head: { type: Number, default: null },
    esol_session_rate: { type: Number, default: null },
    reporting_contact_email: {
      type: String,
      default: null,
      lowercase: true,
      trim: true,
    },
    billing_active: { type: Boolean, default: true },
    is_demo: { type: Boolean, default: false },
    is_employer: { type: Boolean, default: false },
    notes: { type: String, default: null },
    created_by: { type: Schema.Types.ObjectId, ref: "User", default: null },

    // ── Addendum §4 — teacher multiplier model ────────────────────────
    assigned_teacher_ids: {
      type: [{ type: Schema.Types.ObjectId, ref: "User" }],
      default: [],
    },
    max_learners_per_teacher: { type: Number, default: 150 },

    // ── Phase 2 / Final Addendum §13 (BE-G) — onboarding embed ────────
    // Stamps the moment the org_admin either submits the ROI calculator
    // or explicitly skips it from the onboarding-embed path. Null while
    // onboarding is pending; once stamped never re-blocks (the field
    // exists for a future onboarding workflow that may chain off it —
    // we deliberately did NOT name it `roi_calculator_completed_at`).
    org_onboarding_completed_at: { type: Date, default: null },

    // ── Addendum §21 — MIS integration (encrypted credentials at rest) ─
    misType: {
      type: String,
      enum: ["ProSolution", "Maytas", "EBS", "none"],
      default: "none",
    },
    misApiEndpoint: { type: String, default: null },
    misApiCredentials: { type: String, default: null }, // cryptr-encrypted
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret) {
        delete ret.__v;
        // Never expose encrypted credentials over the wire — services that
        // need them call decryptMisCredentials() explicitly, and that
        // never returns through res.json().
        delete ret.misApiCredentials;
      },
    },
  },
);

// ── Indexes ────────────────────────────────────────────────────────────
// slug uniqueness is declared via `unique: true` on the field above —
// duplicating it here triggers Mongoose's "Duplicate schema index" warning.
organisationSchema.index({ adminUserId: 1 });
// Critical guardrail: any production ILR / RARPA export MUST filter
// is_demo: false. This index makes that filter cheap.
organisationSchema.index({ is_demo: 1 });

const Organisation = model<IOrganisation>("Organisation", organisationSchema);

export default Organisation;
