import jwt from "jsonwebtoken";
import * as bcrypt from "bcrypt";
import { randomBytes } from "crypto";
import { v4 as uuidv4 } from "uuid";
import ApiError from "../errors/apiError";
import ApiResponse from "../errors/apiResponse";
import User from "../models/User";
import Organisation from "../models/Organisation";
import ReferralToken from "../models/ReferralToken";
import AuditLog from "../models/AuditLog";
import PostcodeRouter from "./postcodeRouter.service";
import ComplianceConfigService from "./ComplianceConfigService";
import { createNotification } from "./notification.service";
import logger from "../config/logger";

/**
 * POST /api/esol/register — brief Function 2 To-Do 2.
 *
 * Creates a learner User from a referral token. No auth required — the
 * learner doesn't have an account yet. The returned JWT signs them in
 * immediately so subsequent wizard steps (eligibility, ULN, placement)
 * can use authenticated routes.
 *
 * Validation already passed the gate (see esolRegister.validation.ts).
 * The service trusts the validator on shape and enforces business rules
 * here:
 *   - JWT re-verified (never trust client state, even validated state)
 *   - Postcode → SOF routing via Redis-backed PostcodeRouter (<10ms)
 *   - Funding status: "fundable" if SOF found, "manual_review" if not
 *   - Placeholder email + random password if learner has no email yet —
 *     never communicated; learner authenticates via JWT only
 *   - AuditLog row written on success with the current ILR config
 *     version, so future audits can replay what rules were in force
 */

const SALT_ROUNDS = 13;

interface ReferralJwt {
  org_id?: string;
  orgId?: string;
  type?: string;
}

export interface EsolRegisterPayload {
  token: string;
  firstname: string;
  lastname: string;
  email?: string;
  date_of_birth: string; // YYYY-MM-DD
  nationality: string;
  sex: 1 | 2;
  ethnicity?: string;
  lldd_health_prob: 1 | 2 | 9;
  employment_status:
    | "unemployed"
    | "employed"
    | "self_employed"
    | "not_in_labour_market";
  l1_language:
    | "arabic"
    | "somali"
    | "dari"
    | "pashto"
    | "cantonese"
    | "english";
  postcode_prior: string;
}

export const esolRegisterService = async (data: EsolRegisterPayload) => {
  const referralSecret = process.env.REFERRAL_JWT_SECRET;
  const jwtSecret = process.env.JWT_SECRET;
  if (!referralSecret) {
    throw new ApiError(500, "REFERRAL_JWT_SECRET is not configured");
  }
  if (!jwtSecret) {
    throw new ApiError(500, "JWT_SECRET is not configured");
  }

  // ── 1. Re-verify token (never trust client state) ───────────────
  let decoded: ReferralJwt;
  try {
    decoded = jwt.verify(data.token, referralSecret) as ReferralJwt;
  } catch {
    throw new ApiError(401, "Invalid or expired link");
  }
  if (decoded.type !== "esol_referral") {
    throw new ApiError(401, "Invalid or expired link");
  }

  const orgIdFromJwt = decoded.org_id || decoded.orgId;
  if (!orgIdFromJwt) {
    throw new ApiError(401, "Invalid or expired link");
  }

  // Persisted-row checks (deactivation, org match)
  const tokenRow = await ReferralToken.findOne({ token: data.token });
  if (!tokenRow) {
    throw new ApiError(401, "Invalid or expired link");
  }
  if (!tokenRow.isActive) {
    throw new ApiError(403, "This link has been deactivated");
  }
  if (tokenRow.orgId.toString() !== String(orgIdFromJwt)) {
    throw new ApiError(401, "Invalid or expired link");
  }

  const org = await Organisation.findById(tokenRow.orgId);
  if (!org) {
    throw new ApiError(403, "Organisation is not active");
  }
  if (org.billing_active === false) {
    throw new ApiError(403, "Organisation is not active");
  }

  // ── 2. Postcode → SOF routing ───────────────────────────────────
  // Lookup hits Redis (warm cache, ~5-10ms). Failure to find a SOF
  // means the postcode isn't in the loaded DfE dataset — set
  // funding_status to "manual_review" so the org admin chases.
  let sofCode: string | null = null;
  try {
    const routing = await PostcodeRouter.lookup(data.postcode_prior);
    sofCode = routing?.sof ?? null;
  } catch (err) {
    logger.warn(
      { err, postcode: data.postcode_prior },
      "Postcode lookup failed during registration — falling back to manual_review",
    );
  }
  const fundingStatus: "fundable" | "manual_review" = sofCode
    ? "fundable"
    : "manual_review";

  // ── 3. Email handling — provided or placeholder ─────────────────
  // .local is the IANA-reserved TLD for non-routable names (RFC 6762).
  // Generated placeholders can never receive mail, which is the intent.
  const normalisedEmail = data.email?.toLowerCase().trim();
  let resolvedEmail: string;
  if (normalisedEmail) {
    const emailTaken = await User.findOne({ email: normalisedEmail }).lean();
    if (emailTaken) {
      throw new ApiError(409, `Email ${normalisedEmail} is already in use`);
    }
    resolvedEmail = normalisedEmail;
  } else {
    const slug = uuidv4().replace(/-/g, "").slice(0, 16);
    resolvedEmail = `learner-${slug}@esol-placeholder.local`;
  }

  // ── 4. Create the learner User ─────────────────────────────────
  // Random password — learner can't sign in via email+password and
  // doesn't need to; the JWT we return is the auth mechanism. A future
  // "claim my account" flow can let the learner set a real password.
  const randomPassword = randomBytes(32).toString("hex");
  const hashedPassword = await bcrypt.hash(randomPassword, SALT_ROUNDS);

  const learner = await User.create({
    firstname: data.firstname.trim(),
    lastname: data.lastname.trim(),
    email: resolvedEmail,
    // User schema marks phoneNumber required (marketplace path always
    // collected one). ESOL learners onboard without one — placeholder
    // mirrors the email approach and stays unique via the same slug.
    phoneNumber: `esol-placeholder-${uuidv4().replace(/-/g, "").slice(0, 12)}`,
    password: hashedPassword,
    role: "student",
    orgId: org._id,
    status: "active",
    verified: true,
    isActive: true,
    dateOfBirth: new Date(data.date_of_birth),
    nationality: data.nationality.trim(),
    sex: data.sex,
    ethnicity: data.ethnicity?.trim() || null,
    lldd_health_prob: data.lldd_health_prob,
    employment_status: data.employment_status,
    l1Language: data.l1_language,
    postcode_prior: data.postcode_prior.trim().toUpperCase(),
    sof_code: sofCode,
    fundingStatus: fundingStatus,
    esolOnboardedAt: new Date(),
    cohort_status: "new",
  });

  // ── 5. Generate JWT (matches user.service.ts:generateTokens) ────
  const orgIdStr = learner.orgId?.toString() ?? null;
  const accessToken = jwt.sign(
    {
      id: learner._id,
      firstname: learner.firstname,
      lastname: learner.lastname,
      email: learner.email,
      role: learner.role,
      profilePicture: learner.profilePicture,
      orgId: orgIdStr,
      esolLevel: null,
      esolTeacherApproved: null,
      org_id: orgIdStr,
      esol_level: null,
    },
    jwtSecret,
    { expiresIn: "5h" },
  );

  // ── 6. Increment ReferralToken.usage_count (atomic) ─────────────
  await ReferralToken.updateOne(
    { _id: tokenRow._id },
    { $inc: { usage_count: 1 } },
  );

  // ── 7. AuditLog (compliance trail) ──────────────────────────────
  // Look up the current ILR config version so future audits know
  // which rules were in force when this learner enrolled.
  const ilrConfig = ComplianceConfigService.getCurrent("ilr");
  await AuditLog.create({
    timestamp: new Date(),
    actor_type: "learner",
    actor_id: learner._id,
    org_id: org._id,
    learner_id: learner._id,
    action: "learner_registered",
    before_state: {},
    after_state: {
      org_id: orgIdStr,
      esol_level: null,
      l1_language: data.l1_language,
      funding_status: fundingStatus,
      sof_code: sofCode,
    },
    reason: "Learner self-registered via referral link",
    compliance_config_version: ilrConfig?.version ?? null,
  }).catch((err) =>
    // AuditLog failure must not roll back registration — log and continue.
    // A missing audit row is recoverable; a failed registration is not.
    logger.error(
      { err, learnerId: learner._id, orgId: org._id },
      "AuditLog write failed for learner_registered",
    ),
  );

  // ── 8. Manual-review notification (brief D1-T6) ─────────────────
  // If the postcode wasn't in the DfE dataset, funding routing can't be
  // automated. Notify every org_admin attached to this org so someone
  // chases it before the next ILR window. Fire-and-forget — a failed
  // notification must not roll back registration.
  if (fundingStatus === "manual_review") {
    User.find({ orgId: org._id, role: "org_admin", isActive: true })
      .select("_id")
      .lean()
      .then((admins) =>
        Promise.all(
          admins.map((a) =>
            createNotification({
              userId: a._id,
              type: "system",
              title: "Learner needs funding review",
              message: `${learner.firstname} ${learner.lastname} registered with a postcode not in the ASF dataset. Set funding routing manually before the next ILR submission.`,
              data: {
                learner_id: learner._id.toString(),
                postcode_prior: data.postcode_prior.trim().toUpperCase(),
                org_id: orgIdStr,
                reason: "postcode_not_in_dataset",
              },
            }),
          ),
        ),
      )
      .catch((err) =>
        logger.error(
          { err, learnerId: learner._id, orgId: org._id },
          "Manual-review notification fan-out failed",
        ),
      );
  }

  return new ApiResponse(201, "Registration complete", {
    token: accessToken,
    user: {
      id: learner._id.toString(),
      firstname: learner.firstname,
      role: learner.role,
      org_id: orgIdStr,
      l1_language: learner.l1Language,
    },
    funding_status: fundingStatus,
  });
};
