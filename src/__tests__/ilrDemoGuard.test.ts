/**
 * Demo-org guard tests — brief Function 13.
 *
 * The brief mandates that fictional organisations must NEVER produce
 * real ILR data. There are two layers of refusal in the pipeline:
 *
 *   - triggerIlrExportService (route layer)   covered by ilrExportRoutes.test.ts:R1
 *   - buildIlrRows (service layer)            covered HERE
 *
 * The route-layer test pins the user-facing 403. These tests pin the
 * service-layer guard so any future caller of buildIlrRows — a CLI
 * script, Function 14's green-light re-validation, a misconfigured
 * route that skips the trigger service — still hits the same brick
 * wall.
 *
 *   D1   Demo org with no learners, no sessions → 403
 *   D2   Demo org with EVERY validity condition aligned → still 403
 *   D3   Demo org propagates through runIlrExport too
 *   D4   Non-demo org with same fixture passes through cleanly
 *   D5   Missing org → 404 (not 403 — distinct remediation)
 *   D6   Guard runs BEFORE any compliance-config read
 *   D7   Exact error message matches the brief verbatim
 *   D8   `is_demo` defaults to false on Organisation create
 */

process.env.REFERRAL_JWT_SECRET =
  process.env.REFERRAL_JWT_SECRET ?? "test-secret";

// Stub Redis-backed dependencies — irrelevant to the guard test
jest.mock("../services/falaCache.service", () => ({
  __esModule: true,
  default: { isValidAim: jest.fn().mockResolvedValue(true) },
}));
jest.mock("../services/postcodeRouter.service", () => ({
  __esModule: true,
  default: { lookup: jest.fn().mockResolvedValue({ sof: "105" }) },
}));

import { Types } from "mongoose";
import Organisation from "../models/Organisation";
import User from "../models/User";
import AISession from "../models/AISession";
import ComplianceConfig from "../models/ComplianceConfig";
import ComplianceConfigService from "../services/ComplianceConfigService";
import { buildIlrRows, runIlrExport } from "../services/ilrExport.service";

const ACADEMIC_YEAR = "2025/26";

// ─────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────

const seedConfig = async () => {
  await ComplianceConfig.deleteMany({
    domain: "ilr",
    academic_year: ACADEMIC_YEAR,
  });
  await ComplianceConfig.create({
    domain: "ilr",
    academic_year: ACADEMIC_YEAR,
    version: 1,
    active: true,
    rules: {
      field_name_overrides: {},
      valid_sof_codes: ["105"],
      expired_llddt_codes: [],
      llddt_remapping: {},
      fund_model: 38,
      aim_type_default: 4,
      esol_level_to_aim_ref: { e2: "60139572" },
      english_prog_type_default: "25",
      add_hours_suppression_rule: {
        regulated: "claim",
        non_regulated: "suppress",
        missing: "suppress",
      },
      valid_dam_codes: ["SOF"],
    },
    updated_by: null,
    updated_at: new Date(),
    changelog: "seed",
  });
  await ComplianceConfigService.loadAll();
};

const createOrg = (opts: { is_demo?: boolean; name?: string } = {}) =>
  Organisation.create({
    name: opts.name ?? "Test Org",
    slug: `demo-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    contactEmail: "admin@test.local",
    adminUserId: new Types.ObjectId(),
    billing_active: true,
    isActive: true,
    ...(opts.is_demo !== undefined ? { is_demo: opts.is_demo } : {}),
  });

const createLearner = (orgId: unknown) =>
  User.create({
    firstname: "Demo",
    lastname: "Learner",
    email: `d-${Date.now()}-${Math.random().toString(16).slice(2)}@test.local`,
    password: "x",
    phoneNumber: "07000000000",
    role: "student",
    orgId,
    isActive: true,
    status: "active",
    verified: true,
    dateOfBirth: new Date("1990-01-01"),
    sex: 1,
    esolOnboardedAt: new Date("2025-09-01"),
    uln: "9999999999",
    esol_aim_type: "regulated",
    esolLevel: "e2",
    sof_code: "105",
    lldd_health_prob: 9,
    english_prog_type: "25",
    postcode_prior: "NE1 1AA",
  });

const seedSession = (learnerId: unknown, orgId: unknown) =>
  AISession.create({
    learnerId,
    orgId,
    sessionMode: "BRIDGE",
    esolLevel: "e2",
    turns: [],
    safeguardingFlagged: false,
    vocabIntroduced: [],
    session_source: "ai_tutor",
    duration_mins: 60,
    turn_scores: [],
    teaching_mode_sequence: [],
    start_time: new Date("2025-11-01T10:00:00Z"),
  });

beforeEach(async () => {
  await seedConfig();
});

// ═════════════════════════════════════════════════════════════════════
// D1–D8
// ═════════════════════════════════════════════════════════════════════

describe("buildIlrRows — demo-org guard (brief Function 13)", () => {
  it("D1 — empty demo org (no learners, no sessions) → 403", async () => {
    const org = await createOrg({ is_demo: true });
    await expect(
      buildIlrRows(org._id.toString(), ACADEMIC_YEAR),
    ).rejects.toMatchObject({
      statusCode: 403,
      message: expect.stringMatching(/demo organisations/i),
    });
  });

  it("D2 — fully-loaded demo org (would-be-valid data) → still 403", async () => {
    // This is the "regardless of role or other state" assertion from
    // the brief: even when every other validation gate would pass,
    // the demo flag short-circuits the whole pipeline.
    const org = await createOrg({ is_demo: true, name: "Sales Demo FE" });
    const learner = await createLearner(org._id);
    await seedSession(learner._id, org._id);

    await expect(
      buildIlrRows(org._id.toString(), ACADEMIC_YEAR),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("D3 — runIlrExport also refuses (the demo guard propagates through the wrap)", async () => {
    const org = await createOrg({ is_demo: true });
    await createLearner(org._id);

    await expect(
      runIlrExport({
        org_id: org._id.toString(),
        academic_year: ACADEMIC_YEAR,
        period_start: "2025-08-01",
        period_end: "2026-07-31",
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("D4 — non-demo org with identical fixture passes through cleanly", async () => {
    const org = await createOrg({ is_demo: false });
    const learner = await createLearner(org._id);
    await seedSession(learner._id, org._id);

    const out = await buildIlrRows(org._id.toString(), ACADEMIC_YEAR);
    expect(out.config_missing).toBe(false);
    expect(out.rows.length).toBeGreaterThan(0);
    // Sanity check — confirms the rest of the pipeline ran end-to-end
    expect(out.rows[0].ULN).toBe("9999999999");
  });

  it("D5 — non-existent org id → 404 (distinct from 403 for remediation)", async () => {
    // The brief explicitly distinguishes "org not found" from "org is
    // demo": the former is a caller error (bad id), the latter is a
    // policy refusal. Different status codes, different UI messages.
    await expect(
      buildIlrRows(new Types.ObjectId().toString(), ACADEMIC_YEAR),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("D6 — guard runs BEFORE any compliance-config read", async () => {
    // Wipe the config so a reachable downstream path would log an
    // error and return { config_missing: true }. With the guard in
    // place we should THROW 403 instead — proving the demo check
    // fires first.
    await ComplianceConfig.deleteMany({ domain: "ilr" });
    await ComplianceConfigService.loadAll();

    const org = await createOrg({ is_demo: true });
    await expect(
      buildIlrRows(org._id.toString(), ACADEMIC_YEAR),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("D7 — exact error message matches the brief verbatim", async () => {
    const org = await createOrg({ is_demo: true });
    let caught: { statusCode?: number; message?: string } | undefined;
    try {
      await buildIlrRows(org._id.toString(), ACADEMIC_YEAR);
    } catch (err) {
      caught = err as typeof caught;
    }
    expect(caught?.statusCode).toBe(403);
    expect(caught?.message).toBe(
      "ILR export is disabled for demo organisations. Demo data must never be submitted to ESFA.",
    );
  });

  it("D8 — is_demo defaults to false on Organisation create — explicit non-demo orgs are the norm", async () => {
    // Belt-and-braces sanity test. The Organisation schema sets
    // is_demo: { default: false } — confirm that, so a future schema
    // change to default: true would break loudly here rather than
    // silently letting every new org skip the ILR pipeline.
    const org = await createOrg(); // no is_demo override
    const fresh = await Organisation.findById(org._id).lean();
    expect(fresh?.is_demo).toBe(false);
  });
});
