import jwt from "jsonwebtoken";
import * as bcrypt from "bcrypt";
import { randomBytes } from "crypto";
import { Types } from "mongoose";
import { v4 as uuidv4 } from "uuid";
import ApiError from "../errors/apiError";
import ApiResponse from "../errors/apiResponse";
import ReferralToken from "../models/ReferralToken";
import Organisation from "../models/Organisation";
import User from "../models/User";
import { IUseReferralTokenRequest } from "../interfaces/referralToken.interface";
import {
  sendVerificationMail,
  sendLearnerInviteMail,
} from "./nodemailer/mail.service";
import { validatePassword } from "../utils/validatePassword";

const SALT_ROUNDS = 13;
const DOMAIN_NAME = process.env.DOMAIN_NAME;

interface ReferralJwtPayload {
  /**
   * Type-tag for the JWT. brief Function 2 To-Do 1 requires verify to
   * reject any token that isn't `esol_referral` — the same JWT library
   * is used for user auth, password resets, etc., so the type field is
   * what stops a stolen reset-link from being mis-presented as an
   * invitation. Without this, every freshly-minted invitation token
   * fails verification with the misleading "Invalid or expired link"
   * error, since `verifyReferralTokenService` checks
   * `decoded.type !== "esol_referral"`.
   */
  type: "esol_referral";
  /** Legacy camelCase orgId — verify accepts both for back-compat. */
  orgId: string;
  /** Snake-case org_id — matches the brief Function 2 contract. */
  org_id: string;
  esolLevel?: string;
  email?: string;
  jti: string;
}

/* ── Create Referral Token ── */

export const createReferralTokenService = async (
  data: {
    orgId?: string;
    email?: string;
    esolLevel?: string;
    expiresInDays?: number;
  },
  callerOrgId: string | null | undefined,
  callerRole: string,
) => {
  const secret = process.env.REFERRAL_JWT_SECRET;
  if (!secret) {
    throw new ApiError(500, "Referral JWT secret is not configured");
  }

  const resolvedOrgId = callerRole === "org_admin" ? callerOrgId : data.orgId;

  if (!resolvedOrgId) {
    throw new ApiError(400, "Organisation ID is required");
  }

  const org = await Organisation.findById(resolvedOrgId);
  if (!org || !org.isActive) {
    throw new ApiError(404, "Organisation not found or is inactive");
  }

  // ── Duplicate-invite guard ──
  // A per-email invite is blocked when EITHER:
  //   1. A user with this email already exists — the invite would
  //      bounce off the registration's unique-email check anyway, so
  //      fail fast with a precise message.
  //   2. A PENDING invite to the same email already exists for this
  //      org (active, unused, unexpired). Expired or revoked invites
  //      don't block — re-inviting after those is the expected flow.
  // Generic links (no email) are exempt — an org can hold several.
  if (data.email) {
    const normalisedEmail = data.email.toLowerCase();

    const existingUser = await User.findOne({ email: normalisedEmail })
      .select("_id")
      .lean();
    if (existingUser) {
      throw new ApiError(409, "A user with this email is already registered");
    }

    const pendingInvite = await ReferralToken.findOne({
      orgId: resolvedOrgId,
      email: normalisedEmail,
      isActive: true,
      usedBy: null,
      expiresAt: { $gt: new Date() },
    })
      .select("_id")
      .lean();
    if (pendingInvite) {
      throw new ApiError(409, "This user has already been invited");
    }
  }

  const expiresInDays = data.expiresInDays ?? 30;
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + expiresInDays);

  const jti = uuidv4();

  // Payload includes BOTH the snake_case `org_id` (brief Function 2
  // contract) AND the legacy `orgId` so existing verify paths keep
  // working through the cutover. The `type: "esol_referral"` tag is
  // the critical fix — without it `verifyReferralTokenService` rejects
  // the freshly-minted token with "Invalid or expired link", which
  // is what the user reported when clicking their invitation email
  // even though the link's actual JWT exp was 30 days out.
  const payload: ReferralJwtPayload = {
    type: "esol_referral",
    org_id: resolvedOrgId,
    orgId: resolvedOrgId,
    jti,
    ...(data.esolLevel && { esolLevel: data.esolLevel }),
    ...(data.email && { email: data.email.toLowerCase() }),
  };

  const token = jwt.sign(payload, secret, {
    expiresIn: `${expiresInDays}d`,
  });

  const referralToken = await ReferralToken.create({
    orgId: resolvedOrgId,
    token,
    email: data.email?.toLowerCase(),
    esolLevel: data.esolLevel,
    expiresAt,
    isActive: true,
  });

  const inviteUrl = `${DOMAIN_NAME}/esol/join?token=${token}`;

  if (data.email) {
    const expiryDate = expiresAt.toLocaleDateString("en-GB", {
      day: "numeric",
      month: "long",
      year: "numeric",
    });
    await sendLearnerInviteMail({
      toEmail: data.email,
      orgName: org.name,
      esolLevel: data.esolLevel || "To be assessed",
      inviteUrl,
      expiryDate,
    });
  }

  return new ApiResponse(201, "Invitation created successfully", {
    referralToken: referralToken.toJSON(),
    inviteUrl,
  });
};

/* ── List Referral Tokens ── */

export const listReferralTokensService = async (
  callerOrgId: string | null | undefined,
  callerRole: string,
  options: {
    orgId?: string;
    page?: string;
    limit?: string;
    isActive?: string;
  },
) => {
  const page = parseInt(options.page || "1", 10);
  const limit = parseInt(options.limit || "20", 10);
  const skip = (page - 1) * limit;

  const resolvedOrgId =
    callerRole === "org_admin" ? callerOrgId : options.orgId;

  if (!resolvedOrgId) {
    throw new ApiError(400, "Organisation ID is required");
  }

  const query: any = { orgId: resolvedOrgId };
  if (options.isActive !== undefined) {
    query.isActive = options.isActive === "true";
  }

  const [tokens, total] = await Promise.all([
    ReferralToken.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit),
    ReferralToken.countDocuments(query),
  ]);

  return new ApiResponse(200, "Invitations retrieved successfully", {
    tokens,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
};

/* ── Pending-invite lookup (shared by revoke + remind) ──────────────
   Loads the token row, enforces org ownership (an org_admin can only
   touch their own org's invites; a platform admin can touch any), and
   verifies the invite is still actionable — i.e. genuinely pending.
─────────────────────────────────────────────────────────────────── */

const loadPendingInvite = async (
  tokenId: string,
  callerOrgId: string | null | undefined,
  callerRole: string,
) => {
  if (!Types.ObjectId.isValid(tokenId)) {
    throw new ApiError(400, "Invalid invitation ID");
  }

  const row = await ReferralToken.findById(tokenId);
  if (!row) {
    throw new ApiError(404, "Invitation not found");
  }

  // Org ownership — org_admins are scoped to their own org.
  if (
    callerRole === "org_admin" &&
    (!callerOrgId || row.orgId.toString() !== String(callerOrgId))
  ) {
    throw new ApiError(
      403,
      "You can only manage your own organisation's invitations",
    );
  }

  if (row.usedBy) {
    throw new ApiError(409, "This invitation has already been accepted");
  }
  if (!row.isActive) {
    throw new ApiError(409, "This invitation has already been revoked");
  }

  return row;
};

/* ── Revoke Invitation ──────────────────────────────────────────────
   PATCH /api/esol/referrals/:id/revoke (org_admin | admin)

   Only PENDING invites can be revoked — accepted ones are immutable
   history (the learner already registered through them), and already-
   revoked ones 409 so a double-click doesn't read as success twice.
   Revocation flips isActive=false; `verifyReferralTokenService` then
   rejects the link with its distinct 403 "deactivated" message.
─────────────────────────────────────────────────────────────────── */

export const revokeReferralTokenService = async (
  tokenId: string,
  callerOrgId: string | null | undefined,
  callerRole: string,
) => {
  const row = await loadPendingInvite(tokenId, callerOrgId, callerRole);

  row.isActive = false;
  await row.save();

  return new ApiResponse(200, "Invitation revoked", {
    referralToken: row.toJSON(),
  });
};

/* ── Remind (re-send invite email) ──────────────────────────────────
   POST /api/esol/referrals/:id/remind (org_admin | admin)

   Re-sends the SAME invite link (same token, same expiry) to the
   invitee. Only valid for pending, per-email, unexpired invites —
   a generic link has nobody to remind, and an expired invite needs
   a fresh invitation, not a nudge to a dead link.
─────────────────────────────────────────────────────────────────── */

export const remindReferralTokenService = async (
  tokenId: string,
  callerOrgId: string | null | undefined,
  callerRole: string,
) => {
  const row = await loadPendingInvite(tokenId, callerOrgId, callerRole);

  if (!row.email) {
    throw new ApiError(
      400,
      "This is a generic invitation link — there is no email address to remind",
    );
  }
  if (row.expiresAt < new Date()) {
    throw new ApiError(
      409,
      "This invitation has expired — send a new invitation instead",
    );
  }

  const org = await Organisation.findById(row.orgId).select("name");
  if (!org) {
    throw new ApiError(404, "Organisation not found");
  }

  const inviteUrl = `${DOMAIN_NAME}/esol/join?token=${row.token}`;
  const expiryDate = row.expiresAt.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  await sendLearnerInviteMail({
    toEmail: row.email,
    orgName: org.name,
    esolLevel: row.esolLevel || "To be assessed",
    inviteUrl,
    expiryDate,
  });

  row.lastRemindedAt = new Date();
  row.reminder_count = (row.reminder_count ?? 0) + 1;
  await row.save();

  return new ApiResponse(200, "Reminder sent", {
    referralToken: row.toJSON(),
  });
};

/* ── Verify Token (brief Function 2 To-Do 1) ────────────────────────
   POST /api/esol/verify-token public endpoint.

   Parallel to the legacy `validateReferralTokenService` below, which has
   a different payload shape (camelCase `orgId`, no `type` claim) and a
   different return shape (orgName/orgLogoUrl/esolLevel/email). The
   brief Function 2 contract speaks snake_case + type-tagged claims and
   returns `{ org_id, org_name, org_type }`.

   Status codes per brief:
     401 on JWT failures (expired / tampered / wrong signature / wrong type)
     403 when org missing or billing inactive
     403 when ReferralToken row is marked inactive
     200 on success — atomically increments usage_count

   Defence-in-depth: the JWT's `org_id` must match the persisted row's
   orgId. Prevents a forged-but-correctly-signed JWT (e.g. via leaked
   secret) from impersonating a different org's tokens.
─────────────────────────────────────────────────────────────────── */

interface VerifyReferralJwt {
  org_id?: string;
  orgId?: string; // legacy alias accepted for back-compat
  type?: string;
}

export const verifyReferralTokenService = async (token: string) => {
  const secret = process.env.REFERRAL_JWT_SECRET;
  if (!secret) {
    throw new ApiError(500, "REFERRAL_JWT_SECRET is not configured");
  }

  // 1. JWT signature + expiry
  let decoded: VerifyReferralJwt;
  try {
    decoded = jwt.verify(token, secret) as VerifyReferralJwt;
  } catch {
    throw new ApiError(401, "Invalid or expired link");
  }

  // 2. Type claim — must be esol_referral. Other JWTs in the system
  //    (user auth, password reset, etc.) use the same library; the type
  //    field is what stops them from being mis-presented as referral
  //    links.
  if (decoded.type !== "esol_referral") {
    throw new ApiError(401, "Invalid or expired link");
  }

  const orgIdFromJwt = decoded.org_id || decoded.orgId;
  if (!orgIdFromJwt || !Types.ObjectId.isValid(String(orgIdFromJwt))) {
    throw new ApiError(401, "Invalid or expired link");
  }

  // 3. Look up the persisted ReferralToken row by the JWT string itself.
  //    We find first (with no isActive filter) so we can give the brief's
  //    distinct 403 "deactivated" message vs the generic 401 "invalid".
  const tokenRow = await ReferralToken.findOne({ token });
  if (!tokenRow) {
    throw new ApiError(401, "Invalid or expired link");
  }
  if (!tokenRow.isActive) {
    throw new ApiError(403, "This link has been deactivated");
  }

  // Defence-in-depth — JWT org_id must match the row's stored orgId.
  // Belt-and-braces against a leaked-secret forgery scenario.
  if (tokenRow.orgId.toString() !== String(orgIdFromJwt)) {
    throw new ApiError(401, "Invalid or expired link");
  }

  // 4. Organisation lookup + billing_active gate.
  const org = await Organisation.findById(tokenRow.orgId).select(
    "name type billing_active",
  );
  if (!org) {
    throw new ApiError(403, "Organisation is not active");
  }
  if (org.billing_active === false) {
    throw new ApiError(403, "Organisation is not active");
  }

  // 5. Atomic increment of usage_count. updateOne with $inc is a single
  //    Mongo operation — safe under concurrent verifications.
  await ReferralToken.updateOne(
    { _id: tokenRow._id },
    { $inc: { usage_count: 1 } },
  );

  return new ApiResponse(200, "Token verified", {
    org_id: org._id.toString(),
    org_name: org.name,
    org_type: org.type ?? null,
    // Per-email invites carry the invitee's address — the join
    // wizard prefills + locks the email field with it so the
    // learner can't register under a different address and hit
    // the "issued for a different email" 400 at the final step.
    // Generic links → null (email stays editable).
    invited_email: tokenRow.email ?? null,
    // Pre-assigned level, when the org admin set one at invite time.
    esol_level: tokenRow.esolLevel ?? null,
  });
};

/* ── Validate Token (public preview, LEGACY) ── */

export const validateReferralTokenService = async (token: string) => {
  const secret = process.env.REFERRAL_JWT_SECRET;
  if (!secret) {
    throw new ApiError(500, "Referral JWT secret is not configured");
  }

  let decoded: ReferralJwtPayload;
  try {
    decoded = jwt.verify(token, secret) as ReferralJwtPayload;
  } catch {
    throw new ApiError(400, "Invalid or expired invitation link");
  }

  const referralToken = await ReferralToken.findOne({ token, isActive: true });
  if (!referralToken || referralToken.usedBy) {
    throw new ApiError(
      400,
      "This invitation has already been used or is no longer valid",
    );
  }

  if (referralToken.expiresAt < new Date()) {
    throw new ApiError(400, "This invitation link has expired");
  }

  const org = await Organisation.findById(decoded.orgId).select("name logoUrl");
  if (!org || !org.isActive) {
    throw new ApiError(
      400,
      "The organisation associated with this invitation is no longer active",
    );
  }

  return new ApiResponse(200, "Invitation is valid", {
    orgName: org.name,
    orgLogoUrl: org.logoUrl || null,
    esolLevel: decoded.esolLevel || null,
    email: decoded.email || null,
  });
};

/* ── Register Learner via Referral Token ── */

export const registerViaReferralService = async (
  data: IUseReferralTokenRequest,
) => {
  const secret = process.env.REFERRAL_JWT_SECRET;
  if (!secret) {
    throw new ApiError(500, "Referral JWT secret is not configured");
  }

  let decoded: ReferralJwtPayload;
  try {
    decoded = jwt.verify(data.token, secret) as ReferralJwtPayload;
  } catch {
    throw new ApiError(400, "Invalid or expired invitation link");
  }

  const referralToken = await ReferralToken.findOne({
    token: data.token,
    isActive: true,
  });
  if (!referralToken || referralToken.usedBy) {
    throw new ApiError(400, "This invitation has already been used");
  }
  if (referralToken.expiresAt < new Date()) {
    throw new ApiError(400, "This invitation link has expired");
  }

  // If token was issued to a specific email, enforce it
  if (decoded.email && decoded.email !== data.email.toLowerCase()) {
    throw new ApiError(
      400,
      "This invitation was issued for a different email address",
    );
  }

  const existingUser = await User.findOne({ email: data.email.toLowerCase() });
  if (existingUser) {
    throw new ApiError(400, `A user with email ${data.email} already exists`);
  }

  const org = await Organisation.findById(decoded.orgId);
  if (!org || !org.isActive) {
    throw new ApiError(
      400,
      "The organisation associated with this invitation is no longer active",
    );
  }

  validatePassword(data.password);

  const hashedPassword = await bcrypt.hash(data.password, SALT_ROUNDS);
  const verificationToken = randomBytes(32).toString("hex");

  const learner = await User.create({
    firstname: data.firstname,
    lastname: data.lastname,
    email: data.email.toLowerCase(),
    phoneNumber: data.phoneNumber,
    password: hashedPassword,
    verificationToken,
    role: "student",
    status: "unverified",
    verified: false,
    isActive: true,
    orgId: decoded.orgId,
    esolLevel: decoded.esolLevel || null,
    l1Language: data.l1Language || null,
    uln: data.uln || null,
    ulnStatus: data.uln ? "pending" : "not_required",
    esolOnboardedAt: new Date(),
    totalLessonsTaken: 0,
    totalHoursLearned: 0,
    currentStreak: 0,
    longestStreak: 0,
  });

  // Mark token as used
  referralToken.usedBy = learner._id as any;
  referralToken.usedAt = new Date();
  referralToken.isActive = false;
  await referralToken.save();

  await sendVerificationMail(learner).catch(() => {});

  return new ApiResponse(
    201,
    "Account created successfully. Please verify your email to continue.",
    { user: learner.toJSON() },
  );
};
