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
import { sendVerificationMail, sendLearnerInviteMail } from "./nodemailer/mail.service";
import { validatePassword } from "../utils/validatePassword";

const SALT_ROUNDS = 13;
const DOMAIN_NAME = process.env.DOMAIN_NAME;

interface ReferralJwtPayload {
  orgId: string;
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
  callerRole: string
) => {
  const secret = process.env.REFERRAL_JWT_SECRET;
  if (!secret) {
    throw new ApiError(500, "Referral JWT secret is not configured");
  }

  const resolvedOrgId =
    callerRole === "org_admin" ? callerOrgId : data.orgId;

  if (!resolvedOrgId) {
    throw new ApiError(400, "Organisation ID is required");
  }

  const org = await Organisation.findById(resolvedOrgId);
  if (!org || !org.isActive) {
    throw new ApiError(404, "Organisation not found or is inactive");
  }

  const expiresInDays = data.expiresInDays ?? 30;
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + expiresInDays);

  const jti = uuidv4();

  const payload: ReferralJwtPayload = {
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
  }
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
    "name type billing_active"
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
    { $inc: { usage_count: 1 } }
  );

  return new ApiResponse(200, "Token verified", {
    org_id: org._id.toString(),
    org_name: org.name,
    org_type: org.type ?? null,
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
    throw new ApiError(400, "This invitation has already been used or is no longer valid");
  }

  if (referralToken.expiresAt < new Date()) {
    throw new ApiError(400, "This invitation link has expired");
  }

  const org = await Organisation.findById(decoded.orgId).select("name logoUrl");
  if (!org || !org.isActive) {
    throw new ApiError(400, "The organisation associated with this invitation is no longer active");
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
  data: IUseReferralTokenRequest
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
      "This invitation was issued for a different email address"
    );
  }

  const existingUser = await User.findOne({ email: data.email.toLowerCase() });
  if (existingUser) {
    throw new ApiError(400, `A user with email ${data.email} already exists`);
  }

  const org = await Organisation.findById(decoded.orgId);
  if (!org || !org.isActive) {
    throw new ApiError(400, "The organisation associated with this invitation is no longer active");
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
    { user: learner.toJSON() }
  );
};
