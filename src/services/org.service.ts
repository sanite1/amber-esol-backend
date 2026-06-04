import * as bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { Types } from "mongoose";
import ApiError from "../errors/apiError";
import ApiResponse from "../errors/apiResponse";
import Organisation from "../models/Organisation";
import type { IOrganisation } from "../interfaces/organisation.interface";
import User from "../models/User";
import ReferralToken from "../models/ReferralToken";
import { validatePassword } from "../utils/validatePassword";
import { sendOrgAdminWelcomeMail } from "./nodemailer/mail.service";
import { buildRoiCalculatorUrl } from "./roiCalculatorUrl.service";
import logger from "../config/logger";

// Match the salt rounds used elsewhere in the codebase (user.service.ts).
const SALT_ROUNDS = 13;

// Login URL surfaced in the welcome email. Defaults to the brief's
// canonical host; override via env for staging / dev.
const ESOL_LOGIN_URL =
  process.env.ESOL_LOGIN_URL ||
  (process.env.ESOL_LANDING_URL
    ? `${process.env.ESOL_LANDING_URL}/login`
    : "https://esol.ambertraining.co.uk/login");

/**
 * /api/orgs services — brief Function 1.
 *
 * Snake_case-shaped input/output that matches the brief's spec. The
 * underlying Organisation schema mixes camelCase (slug, contractStart,
 * maxLearners, isActive) with snake_case (monthly_fee_per_head,
 * esol_session_rate, is_demo, etc.) for historical reasons; the mapping
 * happens here in the service layer so the API surface stays clean.
 *
 * Compared to the legacy esolOrganisation.service.ts:
 *   - createOrg() requires fewer fields (no admin user, no contact email)
 *   - update only permits the six brief-mandated fields
 *   - list aggregates learner_count + contract_status server-side so the
 *     org admin dashboard doesn't need N+1 queries
 */

// ── Helpers ──────────────────────────────────────────────────────────

/** Slugify "Greenwich Community College" → "greenwich-community-college". */
const slugify = (name: string): string =>
  name
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 80);

/**
 * Generate a slug that's guaranteed unique against the orgs collection.
 * Appends -2, -3, etc. on collision (cheap because slug has a unique index).
 */
const uniqueSlug = async (base: string): Promise<string> => {
  let slug = base || `org-${Date.now()}`;
  let suffix = 2;
  // Limit attempts so we can't infinite-loop on a pathological case.
  for (let i = 0; i < 50; i++) {
    const existing = await Organisation.findOne({ slug }).lean();
    if (!existing) return slug;
    slug = `${base}-${suffix++}`;
  }
  throw new ApiError(500, "Could not generate unique organisation slug");
};

type ContractStatus = "upcoming" | "active" | "expired" | "no_contract";

const computeContractStatus = (
  start?: Date | null,
  end?: Date | null
): ContractStatus => {
  if (!start && !end) return "no_contract";
  const now = Date.now();
  if (start && now < start.getTime()) return "upcoming";
  if (end && now > end.getTime()) return "expired";
  return "active";
};

/**
 * Strip / project an Organisation document for client return.
 *
 * Important: `misApiCredentials` is omitted unconditionally. The model's
 * toJSON transform also strips it, but services that use .lean() bypass
 * that transform — so we never trust the transform alone.
 */
const toResponseShape = (
  doc: IOrganisation,
  extras: { learner_count?: number } = {}
) => {
  const obj: any = doc.toJSON ? doc.toJSON() : { ...doc };
  delete obj.misApiCredentials;
  obj.contract_status = computeContractStatus(doc.contractStart, doc.contractEnd);
  if (extras.learner_count !== undefined) {
    obj.learner_count = extras.learner_count;
  }
  return obj;
};

// ── Input shapes ─────────────────────────────────────────────────────

export interface CreateOrgBody {
  name: string;
  type: "college" | "council" | "charity" | "employer";
  contract_start?: string | Date;
  contract_end?: string | Date;
  learner_cap?: number;
  monthly_fee_per_head?: number;
  esol_session_rate?: number;
  reporting_contact_email?: string | null;
  is_demo?: boolean;
  is_employer?: boolean;
  notes?: string;
}

export interface UpdateOrgBody {
  learner_cap?: number;
  monthly_fee_per_head?: number;
  esol_session_rate?: number;
  contract_end?: string | Date;
  billing_active?: boolean;
  max_learners_per_teacher?: number;
}

export interface ListOrgsQuery {
  include_demo?: boolean | "true" | "false" | string;
  page?: string | number;
  limit?: string | number;
  search?: string;
}

// ── Service functions ────────────────────────────────────────────────

/**
 * Create a new organisation. Returns { org_id, name } per brief.
 *
 * Fields not present in the body get sensible defaults:
 *   - slug: derived from name (uniquely suffixed if collision)
 *   - billing_active: true
 *   - is_demo: false (unless explicitly passed)
 *   - paymentModel: "invoiced", invoiceCycle: "monthly" (matches legacy defaults)
 *   - adminUserId: null (set later when POST /api/orgs/:id/admin-user runs)
 */
export const createOrgService = async (
  body: CreateOrgBody,
  createdByUserId: string
) => {
  const slug = await uniqueSlug(slugify(body.name));

  const doc = await Organisation.create({
    name: body.name,
    slug,
    type: body.type,
    // Existing camelCase contract fields receive the brief's snake_case input.
    contractStart: body.contract_start ?? null,
    contractEnd: body.contract_end ?? null,
    // learner_cap is the brief's name; the existing schema field is maxLearners.
    maxLearners: body.learner_cap,
    // Brief snake_case fields land verbatim on the schema.
    monthly_fee_per_head: body.monthly_fee_per_head ?? null,
    esol_session_rate: body.esol_session_rate ?? null,
    reporting_contact_email: body.reporting_contact_email ?? null,
    is_demo: body.is_demo ?? false,
    is_employer: body.is_employer ?? false,
    notes: body.notes ?? null,
    billing_active: true,
    created_by: new Types.ObjectId(createdByUserId),
    // Legacy required-ish defaults to keep existing code paths happy.
    paymentModel: "invoiced",
    invoiceCycle: "monthly",
    isActive: true,
    // adminUserId left as null — set by the later "create admin user" route.
  });

  return new ApiResponse(201, "Organisation created", {
    org_id: doc._id.toString(),
    name: doc.name,
  });
};

/**
 * List organisations. Excludes is_demo: true unless ?include_demo=true.
 *
 * For each org, attaches:
 *   - learner_count: number of Users with orgId == this org
 *   - contract_status: derived from contract_start/end
 *   - billing_active: passed through from the document
 *
 * learner_count uses a single aggregation pass against User rather than
 * one countDocuments() per org — N+1 would be expensive on tenant-rich
 * deployments.
 */
export const listOrgsService = async (query: ListOrgsQuery) => {
  const includeDemo =
    query.include_demo === true || query.include_demo === "true";
  const page = Number(query.page ?? 1);
  const limit = Math.min(Number(query.limit ?? 50), 200);
  const skip = (page - 1) * limit;

  const filter: Record<string, unknown> = {};
  if (!includeDemo) filter.is_demo = { $ne: true };
  if (query.search) {
    const escaped = String(query.search).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    filter.name = new RegExp(escaped, "i");
  }

  const [orgs, total] = await Promise.all([
    Organisation.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
    Organisation.countDocuments(filter),
  ]);

  // Single aggregation: learner counts grouped by orgId.
  const orgIds = orgs.map((o) => o._id);
  const countAgg = await User.aggregate<{ _id: Types.ObjectId; n: number }>([
    { $match: { orgId: { $in: orgIds } } },
    { $group: { _id: "$orgId", n: { $sum: 1 } } },
  ]);
  const counts = new Map<string, number>(
    countAgg.map((c) => [c._id.toString(), c.n])
  );

  const data = orgs.map((doc) =>
    toResponseShape(doc, {
      learner_count: counts.get(doc._id.toString()) ?? 0,
    })
  );

  return new ApiResponse(200, "Organisations", {
    organisations: data,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  });
};

/** Returns the full org record (minus misApiCredentials). */
export const getOrgService = async (id: string) => {
  const doc = await Organisation.findById(id);
  if (!doc) throw new ApiError(404, "Organisation not found");

  const learner_count = await User.countDocuments({ orgId: doc._id });
  return new ApiResponse(200, "Organisation", toResponseShape(doc, { learner_count }));
};

/* ── Referral link generation (brief Function 1) ─────────────────── */

/**
 * Landing URL for the public ESOL join flow. Brief specifies
 * https://esol.ambertraining.co.uk — kept overridable via env var so
 * staging / dev environments can point at their own host.
 */
const ESOL_LANDING_URL =
  process.env.ESOL_LANDING_URL || "https://esol.ambertraining.co.uk";

/**
 * Sign a referral JWT for an organisation. Pure JWT layer — does NOT
 * persist a ReferralToken row. Callers (e.g. the referral-link route)
 * generate the JWT and then create the token row themselves.
 *
 * Payload shape is `{ org_id, type: "esol_referral" }` per the brief.
 * Snake_case `org_id` deliberately — this token is parsed by the public
 * /api/esol/referrals/validate endpoint which speaks the brief's shape.
 *
 * `expires_at` is converted to a relative-seconds expiry for jsonwebtoken.
 * Throws if the date is in the past or REFERRAL_JWT_SECRET is missing.
 */
export const generateReferralToken = (
  org_id: string,
  expires_at: Date
): string => {
  const secret = process.env.REFERRAL_JWT_SECRET;
  if (!secret) {
    throw new ApiError(500, "REFERRAL_JWT_SECRET is not configured");
  }

  const expiresInSeconds = Math.floor(
    (expires_at.getTime() - Date.now()) / 1000
  );
  if (expiresInSeconds <= 0) {
    throw new ApiError(400, "expires_at must be in the future");
  }

  return jwt.sign(
    { org_id, type: "esol_referral" },
    secret,
    { expiresIn: expiresInSeconds }
  );
};

/**
 * POST /api/orgs/:id/referral-link service.
 *
 * 1. Look up the organisation; 404 if missing.
 * 2. Resolve expiry: explicit `expires_at` if given, else
 *    `organisation.contractEnd`. If neither is set we can't guess a
 *    sensible default — 400 with a clear message.
 * 3. Sign the JWT via `generateReferralToken`.
 * 4. Persist a ReferralToken row with `created_by`, `usage_count: 0`.
 * 5. Return `{ token, full_url }` per brief.
 */
export const createOrgReferralLinkService = async (
  org_id: string,
  body: { expires_at?: string | Date },
  callerId: string
) => {
  const org = await Organisation.findById(org_id);
  if (!org) throw new ApiError(404, "Organisation not found");

  // Resolve expiry, preferring explicit body value.
  let expiresAt: Date | null = null;
  if (body.expires_at) {
    expiresAt = new Date(body.expires_at);
    if (Number.isNaN(expiresAt.getTime())) {
      throw new ApiError(400, "expires_at must be a valid ISO date");
    }
  } else if (org.contractEnd) {
    expiresAt = new Date(org.contractEnd);
  } else {
    throw new ApiError(
      400,
      "expires_at is required when the organisation has no contract_end set"
    );
  }

  const token = generateReferralToken(org_id, expiresAt);

  const tokenDoc = await ReferralToken.create({
    orgId: new Types.ObjectId(org_id),
    token,
    expiresAt,
    isActive: true,
    created_by: new Types.ObjectId(callerId),
    usage_count: 0,
  });

  const full_url = `${ESOL_LANDING_URL}/join?token=${token}`;

  return new ApiResponse(201, "Referral link generated", {
    token,
    full_url,
    referral_token_id: tokenDoc._id.toString(),
    expires_at: expiresAt.toISOString(),
  });
};

/**
 * List all referral tokens (active and inactive) for an organisation.
 *
 * Returns the full JWT verbatim per row — this endpoint is admin-only,
 * the admin uses the token to reconstruct or re-share an invite link,
 * and the JWT itself doesn't grant access until exchanged through the
 * registration flow which also checks `isActive` on the row.
 *
 * Pagination is offered but defaults are generous (1 page of 100); for
 * MVP, an org will have <100 lifetime referral tokens.
 *
 * Field naming: returns the schema's `isActive` as-is. The brief writes
 * `active` in narrative text — same value, different name.
 */
export const listOrgReferralLinksService = async (
  org_id: string,
  options: { page?: string | number; limit?: string | number } = {}
) => {
  // Cheap upfront validation — clearer error than the empty array a
  // bad org_id would otherwise produce.
  if (!Types.ObjectId.isValid(org_id)) {
    throw new ApiError(400, "Invalid organisation ID");
  }
  const orgExists = await Organisation.exists({ _id: org_id });
  if (!orgExists) throw new ApiError(404, "Organisation not found");

  const page = Math.max(1, Number(options.page ?? 1));
  const limit = Math.min(200, Math.max(1, Number(options.limit ?? 100)));
  const skip = (page - 1) * limit;

  const filter = { orgId: new Types.ObjectId(org_id) };

  const [tokens, total] = await Promise.all([
    ReferralToken.find(filter)
      // Most recent first per brief.
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("created_by", "firstname lastname email")
      .lean(),
    ReferralToken.countDocuments(filter),
  ]);

  // Decorate with a derived full_url so admin can copy-paste without
  // reconstructing it client-side.
  const decorated = tokens.map((t) => ({
    ...t,
    full_url: `${ESOL_LANDING_URL}/join?token=${t.token}`,
  }));

  return new ApiResponse(200, "Referral tokens", {
    referral_tokens: decorated,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  });
};

/**
 * Deactivate a referral token. Sets `isActive: false`; never deletes the
 * row so the audit trail (who created it, when, how many times it was
 * used) survives.
 *
 * Cross-org isolation: the URL carries both `:id` (org) and `:tokenId`.
 * The token must belong to that org or we 404 — prevents an admin from
 * accidentally deactivating the wrong org's link via a malformed URL.
 *
 * Idempotent: re-deactivating an already-inactive token returns the same
 * 200 response rather than 400'ing. Saves an extra "is this already done?"
 * check on the client side.
 */
export const deactivateOrgReferralLinkService = async (
  org_id: string,
  token_id: string
) => {
  if (!Types.ObjectId.isValid(org_id)) {
    throw new ApiError(400, "Invalid organisation ID");
  }
  if (!Types.ObjectId.isValid(token_id)) {
    throw new ApiError(400, "Invalid token ID");
  }

  const token = await ReferralToken.findOne({
    _id: token_id,
    orgId: org_id,
  });
  if (!token) {
    throw new ApiError(404, "Referral token not found for this organisation");
  }

  if (token.isActive) {
    token.isActive = false;
    await token.save();
  }
  // Already inactive → no-op, same shape returned.

  return new ApiResponse(200, "Referral token deactivated", {
    referral_token_id: token._id.toString(),
    isActive: token.isActive,
  });
};

/* ── Create org_admin user (brief Function 1) ─────────────────────── */

/**
 * Create an org_admin User for an organisation.
 *
 *   - 409 (not 400) when email collides — RFC-aligned semantic.
 *   - Account starts `verified: true` and `status: "active"` because the
 *     creating party is an Amber admin who's verified the recipient
 *     out-of-band. Skips the email-verification dance the marketplace
 *     uses for self-registered users.
 *   - Brief specifies BOTH `role: "org_admin"` AND `org_id` set to the
 *     parent organisation. The org_admin's JWT then carries that org_id
 *     and orgScopingMiddleware uses it for all downstream auth.
 *   - Returns `{ user_id, email }` per the brief.
 *
 * Deliberate non-decision:
 *   - We do NOT auto-set this user as the Organisation.adminUserId.
 *     adminUserId is the "primary contact" admin (one per org); the
 *     org_admin role is per-user (an org can have multiple). Setting
 *     adminUserId on first admin creation would conflate the two and
 *     is a separate /api/orgs/:id PATCH if needed.
 */
export const createOrgAdminUserService = async (
  org_id: string,
  body: {
    email: string;
    firstname: string;
    lastname: string;
    password: string;
  }
) => {
  if (!Types.ObjectId.isValid(org_id)) {
    throw new ApiError(400, "Invalid organisation ID");
  }

  const org = await Organisation.findById(org_id);
  if (!org) throw new ApiError(404, "Organisation not found");

  const normalisedEmail = body.email.toLowerCase().trim();

  const existing = await User.findOne({ email: normalisedEmail }).lean();
  if (existing) {
    throw new ApiError(409, `Email ${normalisedEmail} is already in use`);
  }

  // Same strength rules as registerStudentService — consistent policy.
  validatePassword(body.password);
  const hashedPassword = await bcrypt.hash(body.password, SALT_ROUNDS);

  const orgAdmin = await User.create({
    email: normalisedEmail,
    firstname: body.firstname.trim(),
    lastname: body.lastname.trim(),
    // schema requires phoneNumber; stub it as empty string. Org admin
    // can fill from settings on first sign-in.
    phoneNumber: "",
    password: hashedPassword,
    role: "org_admin",
    orgId: org._id,
    status: "active",
    verified: true,
    isActive: true,
  });

  // Final Addendum §13 — prefill the ROI calculator with whatever
  // sales-context we already know about the org. `org.name` and
  // `org.type` are always available on a freshly-created org; the
  // waiting-list / ASF-rate / current-throughput numbers are not
  // captured during the org-creation form today but the helper
  // tolerates their absence and just omits the matching query
  // params. When Joey adds those fields to the create-org wizard
  // (or to a sales-intake form), the prefill picks them up
  // automatically with no further plumbing.
  const roiCalculatorUrl = buildRoiCalculatorUrl({
    org_name: org.name,
    org_type:
      (org as { type?: "college" | "council" | "charity" | "employer" | null })
        .type ?? null,
  });

  // Fire-and-forget email — delivery failure must not roll back creation.
  sendOrgAdminWelcomeMail({
    toEmail: orgAdmin.email,
    firstname: orgAdmin.firstname,
    orgName: org.name,
    loginUrl: ESOL_LOGIN_URL,
    roiCalculatorUrl,
  }).catch((err) =>
    logger.error(
      { err, userId: orgAdmin._id, orgId: org._id },
      "Org admin welcome email failed"
    )
  );

  return new ApiResponse(201, "Organisation admin user created", {
    user_id: orgAdmin._id.toString(),
    email: orgAdmin.email,
  });
};

/**
 * Update only the brief's six permitted fields. Anything else in the body
 * is rejected by the validator before we get here — but this service
 * function also whitelists explicitly as defence in depth.
 */
export const updateOrgService = async (id: string, body: UpdateOrgBody) => {
  const update: Record<string, unknown> = {};
  if (body.learner_cap !== undefined) update.maxLearners = body.learner_cap;
  if (body.monthly_fee_per_head !== undefined)
    update.monthly_fee_per_head = body.monthly_fee_per_head;
  if (body.esol_session_rate !== undefined)
    update.esol_session_rate = body.esol_session_rate;
  if (body.contract_end !== undefined) update.contractEnd = body.contract_end;
  if (body.billing_active !== undefined)
    update.billing_active = body.billing_active;
  if (body.max_learners_per_teacher !== undefined)
    update.max_learners_per_teacher = body.max_learners_per_teacher;

  const doc = await Organisation.findByIdAndUpdate(id, update, {
    new: true,
    runValidators: true,
  });
  if (!doc) throw new ApiError(404, "Organisation not found");

  const learner_count = await User.countDocuments({ orgId: doc._id });
  return new ApiResponse(200, "Organisation updated", toResponseShape(doc, { learner_count }));
};
