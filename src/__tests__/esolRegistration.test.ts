/**
 * D1 acceptance suite — brief Function 2 To-Do 6.
 *
 * Backend coverage of the /join wizard flow. D1-T8 (axe scan) lives in
 * the frontend repo as it needs the browser DOM.
 *
 *   D1-T1  Token verification: valid → 200, expired → 401, tampered → 401
 *   D1-T2  Registration writes correct learner state (org_id, l1, postcode, sof)
 *   D1-T3  Cross-org isolation — Org A learner JWT carries Org A's id
 *   D1-T4  Eligibility declaration sets timestamp + funding_status="fundable"
 *   D1-T5  ULN skip persists "pending" and does not block downstream access
 *   D1-T6  Missing postcode → funding_status="manual_review" + org_admin notified
 *   D1-T7  Org-admin isolation: requireOrgMatch / getLearnerService reject cross-org
 */

// ── Module mocks (must precede the imports of services under test) ──

// PostcodeRouter — controllable per test. The default returns a fixed
// SOF code so the "happy path" registers as "fundable"; D1-T6 overrides
// to return null and asserts the manual_review path.
jest.mock("../services/postcodeRouter.service", () => ({
  __esModule: true,
  default: { lookup: jest.fn() },
}));

// Notification.createNotification — spy only. D1-T6 asserts it ran once
// per org_admin. Other tests don't care.
jest.mock("../services/notification.service", () => ({
  createNotification: jest.fn().mockResolvedValue(undefined),
}));

// ComplianceConfig — no Mongo dependency needed; the service falls back
// to null version if not found, which is acceptable for the audit row.
jest.mock("../services/ComplianceConfigService", () => ({
  __esModule: true,
  default: {
    getCurrent: jest.fn().mockReturnValue({ version: 1 }),
  },
}));

// Mail — never send.
jest.mock("../services/nodemailer/mail.service", () => ({
  sendLearnerInviteMail: jest.fn().mockResolvedValue(undefined),
  sendVerificationMail: jest.fn().mockResolvedValue(undefined),
}));

// Provide the referral JWT secret BEFORE setup.ts runs the test world.
process.env.REFERRAL_JWT_SECRET =
  process.env.REFERRAL_JWT_SECRET ?? "test-referral-secret";

import jwt from "jsonwebtoken";
import { Types } from "mongoose";
import Organisation from "../models/Organisation";
import ReferralToken from "../models/ReferralToken";
import User from "../models/User";
import AuditLog from "../models/AuditLog";
import { verifyReferralTokenService } from "../services/esolReferralToken.service";
import {
  esolRegisterService,
  EsolRegisterPayload,
} from "../services/esolRegister.service";
import { declareEligibilityService } from "../services/esolEligibility.service";
import { declareUlnService } from "../services/esolUln.service";
import { getLearnerService } from "../services/esolLearner.service";
import { requireOrgMatch } from "../middlewares/orgScopingMiddleware";
import PostcodeRouter from "../services/postcodeRouter.service";
import { createNotification } from "../services/notification.service";
import ApiError from "../errors/apiError";

const mockedLookup = (
  PostcodeRouter as unknown as {
    lookup: jest.Mock;
  }
).lookup;
const mockedCreateNotification = createNotification as jest.Mock;

// ── Test helpers ─────────────────────────────────────────────────────

const signReferralJwt = (orgId: string, opts: { ttlSec?: number } = {}) => {
  const payload = {
    org_id: orgId,
    type: "esol_referral",
    jti: `jti-${Date.now()}-${Math.random()}`,
  };
  return jwt.sign(payload, process.env.REFERRAL_JWT_SECRET as string, {
    expiresIn: opts.ttlSec ?? 60 * 60,
  });
};

const createOrg = async (over: Record<string, unknown> = {}) =>
  Organisation.create({
    name: "Test College",
    slug: `org-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    contactEmail: "admin@test.local",
    adminUserId: new Types.ObjectId(),
    billing_active: true,
    isActive: true,
    ...over,
  });

const createReferralRow = async (orgId: string, token: string) =>
  ReferralToken.create({
    orgId,
    token,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    isActive: true,
    usage_count: 0,
  });

const baseRegisterPayload = (
  token: string,
  over: Partial<EsolRegisterPayload> = {},
): EsolRegisterPayload => ({
  token,
  firstname: "Aamina",
  lastname: "Ali",
  date_of_birth: "1995-04-12",
  nationality: "Somali",
  sex: 2,
  lldd_health_prob: 9,
  employment_status: "unemployed",
  l1_language: "somali",
  postcode_prior: "SW1A 1AA",
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  // Default: postcode is in the dataset.
  mockedLookup.mockResolvedValue({
    sof: "108",
    ldm: "001",
    mca: "GLA",
    authority_name: "Greater London Authority",
  });
});

// ── D1-T1 ────────────────────────────────────────────────────────────

describe("D1-T1 — token verification", () => {
  it("valid token returns 200 with org_name", async () => {
    const org = await createOrg({ name: "St Stephens College" });
    const token = signReferralJwt(org._id.toString());
    await createReferralRow(org._id.toString(), token);

    const res = await verifyReferralTokenService(token);

    expect(res.statusCode).toBe(200);
    expect((res.data as any).org_name).toBe("St Stephens College");
    expect((res.data as any).org_id).toBe(org._id.toString());
  });

  it("expired token returns 401", async () => {
    const org = await createOrg();
    const token = signReferralJwt(org._id.toString(), { ttlSec: -10 });
    await createReferralRow(org._id.toString(), token);

    await expect(verifyReferralTokenService(token)).rejects.toMatchObject({
      statusCode: 401,
    });
  });

  it("tampered token (wrong signature) returns 401", async () => {
    const org = await createOrg();
    const realToken = signReferralJwt(org._id.toString());
    await createReferralRow(org._id.toString(), realToken);

    // Mutate the final character of the signature segment.
    const parts = realToken.split(".");
    const lastChar = parts[2].slice(-1);
    parts[2] = parts[2].slice(0, -1) + (lastChar === "A" ? "B" : "A");
    const tampered = parts.join(".");

    await expect(verifyReferralTokenService(tampered)).rejects.toMatchObject({
      statusCode: 401,
    });
  });
});

// ── D1-T2 ────────────────────────────────────────────────────────────

describe("D1-T2 — register creates correct learner record", () => {
  it("persists org_id, l1_language, postcode_prior, and sof_code from lookup", async () => {
    const org = await createOrg();
    const token = signReferralJwt(org._id.toString());
    await createReferralRow(org._id.toString(), token);

    const res = await esolRegisterService(
      baseRegisterPayload(token, {
        l1_language: "arabic",
        postcode_prior: "M1 1AE",
      }),
    );

    expect(res.statusCode).toBe(201);
    const learnerId = (res.data as any).user.id;
    const learner = await User.findById(learnerId).lean();

    expect(learner).toBeTruthy();
    expect(String(learner!.orgId)).toBe(org._id.toString());
    expect(learner!.l1Language).toBe("arabic");
    expect((learner as any).postcode_prior).toBe("M1 1AE");
    expect((learner as any).sof_code).toBe("108");
    expect((learner as any).fundingStatus).toBe("fundable");

    // AuditLog row exists for compliance trail.
    const audit = await AuditLog.findOne({
      learner_id: learnerId,
      action: "learner_registered",
    }).lean();
    expect(audit).toBeTruthy();
  });
});

// ── D1-T3 ────────────────────────────────────────────────────────────

describe("D1-T3 — cross-org isolation at registration", () => {
  it("learner registered via Org A's token receives a JWT bound to Org A only", async () => {
    const orgA = await createOrg({ name: "Org A" });
    const orgB = await createOrg({ name: "Org B" });
    const tokenA = signReferralJwt(orgA._id.toString());
    await createReferralRow(orgA._id.toString(), tokenA);

    const res = await esolRegisterService(baseRegisterPayload(tokenA));
    const accessToken: string = (res.data as any).token;

    const decoded = jwt.verify(
      accessToken,
      process.env.JWT_SECRET as string,
    ) as Record<string, string>;

    expect(decoded.orgId).toBe(orgA._id.toString());
    expect(decoded.orgId).not.toBe(orgB._id.toString());
    expect(decoded.org_id).toBe(orgA._id.toString());

    // Sanity: the learner row also belongs to Org A.
    const learner = await User.findById(decoded.id).lean();
    expect(String(learner!.orgId)).toBe(orgA._id.toString());
  });
});

// ── D1-T4 ────────────────────────────────────────────────────────────

describe("D1-T4 — eligibility declaration", () => {
  it("sets esol_eligibility_declared_at and promotes funding_status to fundable", async () => {
    const org = await createOrg();
    const token = signReferralJwt(org._id.toString());
    await createReferralRow(org._id.toString(), token);

    const reg = await esolRegisterService(baseRegisterPayload(token));
    const learnerId = (reg.data as any).user.id;

    const before = await User.findById(learnerId).lean();
    expect((before as any).esol_eligibility_declared_at).toBeFalsy();

    const out = await declareEligibilityService(learnerId);
    expect(out.statusCode).toBe(200);
    expect((out.data as any).funding_status).toBe("fundable");

    const after = await User.findById(learnerId).lean();
    expect((after as any).esol_eligibility_declared_at).toBeInstanceOf(Date);
    expect((after as any).fundingStatus).toBe("fundable");
  });
});

// ── D1-T5 ────────────────────────────────────────────────────────────

describe("D1-T5 — ULN is optional", () => {
  it("skip path sets uln_status to pending and learner remains an ESOL learner", async () => {
    const org = await createOrg();
    const token = signReferralJwt(org._id.toString());
    await createReferralRow(org._id.toString(), token);

    const reg = await esolRegisterService(baseRegisterPayload(token));
    const learnerId = (reg.data as any).user.id;

    const out = await declareUlnService(learnerId, { skip: true });
    expect(out.statusCode).toBe(200);
    expect((out.data as any).uln_status).toBe("pending");

    const learner = await User.findById(learnerId).lean();
    expect(learner!.uln).toBeNull();
    expect(learner!.ulnStatus).toBe("pending");

    // Still a student attached to the org — downstream learner-only
    // services would still admit them.
    expect(learner!.role).toBe("student");
    expect(String(learner!.orgId)).toBe(org._id.toString());
  });
});

// ── D1-T6 ────────────────────────────────────────────────────────────

describe("D1-T6 — missing postcode in dataset", () => {
  it("sets funding_status to manual_review and notifies every org_admin", async () => {
    mockedLookup.mockResolvedValueOnce(null);

    const org = await createOrg();
    const token = signReferralJwt(org._id.toString());
    await createReferralRow(org._id.toString(), token);

    // Two org admins — both should be notified.
    const adminA = await User.create({
      firstname: "Admin",
      lastname: "A",
      email: `admin-a-${Date.now()}@test.local`,
      password: "x",
      phoneNumber: "07000000000",
      role: "org_admin",
      orgId: org._id,
      isActive: true,
      status: "active",
      verified: true,
    });
    const adminB = await User.create({
      firstname: "Admin",
      lastname: "B",
      email: `admin-b-${Date.now()}@test.local`,
      password: "x",
      phoneNumber: "07000000000",
      role: "org_admin",
      orgId: org._id,
      isActive: true,
      status: "active",
      verified: true,
    });

    const res = await esolRegisterService(baseRegisterPayload(token));
    const learnerId = (res.data as any).user.id;

    expect((res.data as any).funding_status).toBe("manual_review");
    const learner = await User.findById(learnerId).lean();
    expect((learner as any).sof_code).toBeNull();
    expect((learner as any).fundingStatus).toBe("manual_review");

    // Fan-out is fire-and-forget — User.find(...).then(...) plus an
    // inner Promise.all. Poll until both notifications land or time out.
    const deadline = Date.now() + 2000;
    while (
      mockedCreateNotification.mock.calls.length < 2 &&
      Date.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, 20));
    }

    expect(mockedCreateNotification).toHaveBeenCalledTimes(2);
    const userIdsNotified = mockedCreateNotification.mock.calls.map((c) =>
      String((c[0] as any).userId),
    );
    expect(userIdsNotified.sort()).toEqual(
      [adminA._id.toString(), adminB._id.toString()].sort(),
    );
    expect(mockedCreateNotification.mock.calls[0][0]).toMatchObject({
      type: "system",
      data: expect.objectContaining({
        reason: "postcode_not_in_dataset",
        learner_id: learnerId,
      }),
    });
  });
});

// ── D1-T7 ────────────────────────────────────────────────────────────

describe("D1-T7 — org admin isolation", () => {
  it("getLearnerService refuses cross-org learner access", async () => {
    const orgA = await createOrg({ name: "Org A" });
    const orgB = await createOrg({ name: "Org B" });

    const tokenA = signReferralJwt(orgA._id.toString());
    await createReferralRow(orgA._id.toString(), tokenA);

    const regA = await esolRegisterService(baseRegisterPayload(tokenA));
    const learnerInOrgA = (regA.data as any).user.id;

    // Org B admin tries to fetch the Org A learner by passing Org B's id
    // through the scoping middleware (orgId arg = their own).
    await expect(
      getLearnerService(
        orgB._id.toString(),
        learnerInOrgA,
        "org_admin",
        orgB._id.toString(),
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("requireOrgMatch returns 403 when JWT orgId differs from URL :orgId", async () => {
    const orgA = await createOrg({ name: "Org A" });
    const orgB = await createOrg({ name: "Org B" });

    const req: any = {
      user: { role: "org_admin", orgId: orgA._id.toString() },
      params: { orgId: orgB._id.toString() },
    };
    const next = jest.fn();

    await requireOrgMatch(req, {} as any, next);

    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0];
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).statusCode).toBe(403);
  });
});
