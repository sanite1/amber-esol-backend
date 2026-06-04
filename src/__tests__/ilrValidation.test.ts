/**
 * Tests for the ILR validation system — brief Function 13 To-Do 3.
 *
 * Six rules, idempotency wrap, warnings cache.
 *
 *   E1  ULN missing or invalid (not 10 digits) → ERROR
 *   E2  sof_code not on whitelist → ERROR
 *   E3  lldd_health_prob null or not in {1,2,9} → ERROR
 *   W1  non_regulated aim + AddHours > 0 → WARNING + autofix
 *   W2  postcode not in DfE dataset → WARNING
 *   W3  zero-session learner enrolled > 30d ago → WARNING
 *
 *   Idem  runIlrExport idempotent on (org, year, period_start, period_end)
 *   Cache IlrExportWarnings row written, 7-day TTL config
 *   Mix   "cohort of 10 mixed-validity rows" example output
 */

process.env.REFERRAL_JWT_SECRET = process.env.REFERRAL_JWT_SECRET ?? "test-secret";

// PostcodeRouter hits Redis — mock it
const postcodeLookupMock = jest.fn();
jest.mock("../services/postcodeRouter.service", () => ({
  __esModule: true,
  default: { lookup: (...args: unknown[]) => postcodeLookupMock(...args) },
}));

// FALACache — always-valid for the validator tests; the FALA rule
// is the mapper's responsibility (covered in ilrExport.test.ts).
jest.mock("../services/falaCache.service", () => ({
  __esModule: true,
  default: { isValidAim: jest.fn().mockResolvedValue(true) },
}));

import { Types } from "mongoose";
import Organisation from "../models/Organisation";
import User from "../models/User";
import AISession from "../models/AISession";
import ComplianceConfig from "../models/ComplianceConfig";
import IdempotencyKey from "../models/IdempotencyKey";
import IlrExportWarnings from "../models/IlrExportWarnings";
import ComplianceConfigService from "../services/ComplianceConfigService";
import {
  validateRows,
  validateUln,
  validateLlddCode,
  computeExportIdempotencyKey,
  runIlrExport,
  IlrRow,
} from "../services/ilrExport.service";

const ACADEMIC_YEAR = "2025/26";

// ─────────────────────────────────────────────────────────────────────
// Fixture: minimal valid IlrRow
// ─────────────────────────────────────────────────────────────────────

const makeRow = (overrides: Partial<IlrRow> = {}): IlrRow => ({
  ULN: "9999999999",
  FamilyName: "Doe",
  GivenNames: "Jane",
  DateOfBirth: "1990-01-01",
  Sex: 2,
  Ethnicity: "31",
  LLDDHealthProb: 9,
  LearnerEntryDate: "2025-09-01",
  PostcodePrior: "NE1 1AA",
  NINumber: "",
  LearnAimRef: "60139572",
  AimType: 4,
  AimSeqNumber: 1,
  LearnStartDate: "2025-10-01",
  LearnPlanEndDate: null,
  LearnActEndDate: null,
  Outcome: null,
  CompStatus: 1,
  FundModel: 38,
  SOF: "105",
  AddHours: 10,
  EnglishProgType: "25",
  LearnDelFAM: [{ Type: "SOF", Code: "105" }],
  _session_id: new Types.ObjectId().toString(),
  _session_source: "ai_tutor",
  _learner_id: new Types.ObjectId().toString(),
  _total_glh_hours: 5,
  _skill_domains_covered: ["speaking"],
  _aim_invalid: false,
  _suppression_notes: [],
  _warnings: [],
  _skip_row: false,
  ...overrides,
});

const seedConfig = async (overrides: Record<string, unknown> = {}) => {
  await ComplianceConfig.deleteMany({ domain: "ilr", academic_year: ACADEMIC_YEAR });
  const rules = {
    field_name_overrides: { SOC2000: "SOC" },
    valid_sof_codes: ["105", "107"],
    expired_llddt_codes: ["15"],
    llddt_remapping: { "15": 9 },
    fund_model: 38,
    aim_type_default: 4,
    esol_level_to_aim_ref: { e2: "60139572" },
    english_prog_type_default: "25",
    add_hours_suppression_rule: {
      regulated: "claim",
      non_regulated: "suppress",
      missing: "suppress",
    },
    valid_dam_codes: ["SOF", "ACT"],
    ...overrides,
  };
  await ComplianceConfig.create({
    domain: "ilr", academic_year: ACADEMIC_YEAR, version: 1, active: true,
    rules, updated_by: null, updated_at: new Date(), changelog: "seed",
  });
  await ComplianceConfigService.loadAll();
};

beforeEach(async () => {
  postcodeLookupMock.mockReset();
  // Default: every postcode is in the dataset
  postcodeLookupMock.mockResolvedValue({ sof: "105", ldm: null, mca: null });
  await IdempotencyKey.deleteMany({});
  await IlrExportWarnings.deleteMany({});
});

// ═════════════════════════════════════════════════════════════════════
// Pure validators
// ═════════════════════════════════════════════════════════════════════

describe("pure validators", () => {
  it("validateUln — 10 numeric digits only", () => {
    expect(validateUln("9999999999")).toBe(true);
    expect(validateUln(" 9999999999 ")).toBe(true);   // trimmed
    expect(validateUln("999999999")).toBe(false);     // 9 digits
    expect(validateUln("99999999999")).toBe(false);   // 11 digits
    expect(validateUln("999999999A")).toBe(false);    // letter
    expect(validateUln("")).toBe(false);
    expect(validateUln(null)).toBe(false);
    expect(validateUln(undefined)).toBe(false);
  });

  it("validateLlddCode — only {1, 2, 9}", () => {
    expect(validateLlddCode(1)).toBe(true);
    expect(validateLlddCode(2)).toBe(true);
    expect(validateLlddCode(9)).toBe(true);
    expect(validateLlddCode(3)).toBe(false);
    expect(validateLlddCode(0)).toBe(false);
    expect(validateLlddCode(null)).toBe(false);
    expect(validateLlddCode(undefined)).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════
// validateRows — six rules
// ═════════════════════════════════════════════════════════════════════

describe("validateRows", () => {
  beforeEach(async () => {
    await seedConfig();
  });

  it("E1 — invalid ULN blocks the row", async () => {
    const rows = [
      makeRow({ ULN: "999" }),         // too short
      makeRow({ ULN: null }),          // missing
      makeRow(),                        // valid
    ];
    const out = await validateRows(rows, ACADEMIC_YEAR);
    expect(out.valid_rows).toHaveLength(1);
    expect(out.blocked_rows).toHaveLength(2);
    expect(out.blocked_rows[0].errors[0].rule).toBe("uln_invalid");
    expect(out.blocked_rows[0].errors[0].message).toMatch(/not 10 numeric digits/);
    expect(out.blocked_rows[1].errors[0].message).toMatch(/missing/);
  });

  it("E2 — missing SOF blocks the row (warning from breaking-change layer is mirrored)", async () => {
    const row = makeRow({
      SOF: null,
      _warnings: [{ type: "sof_code_invalid", code: "999" }],
    });
    const out = await validateRows([row], ACADEMIC_YEAR);
    expect(out.blocked_rows).toHaveLength(1);
    const err = out.blocked_rows[0].errors.find((e) => e.rule === "sof_code_invalid");
    expect(err).toBeDefined();
    expect(err!.message).toMatch(/"999" not on the 2025\/26 whitelist/);
  });

  it("E3 — LLDD null or out-of-range blocks the row", async () => {
    const rows = [
      makeRow({ LLDDHealthProb: null }),    // missing
      makeRow({ LLDDHealthProb: 3 }),       // not in {1, 2, 9}
      makeRow({ LLDDHealthProb: 1 }),       // valid
    ];
    const out = await validateRows(rows, ACADEMIC_YEAR);
    expect(out.valid_rows).toHaveLength(1);
    expect(out.blocked_rows).toHaveLength(2);
    expect(out.blocked_rows[0].errors[0].rule).toBe("lldd_invalid");
    expect(out.blocked_rows[1].errors[0].rule).toBe("lldd_invalid");
  });

  it("E_skip — breaking-change _skip_row blocks with breaking_change_skip_row + suppresses lldd_invalid", async () => {
    const row = makeRow({
      _skip_row: true,
      LLDDHealthProb: null,
      _warnings: [{ type: "llddt_blocked", code: "15" }],
    });
    const out = await validateRows([row], ACADEMIC_YEAR);
    expect(out.blocked_rows).toHaveLength(1);
    const rules = out.blocked_rows[0].errors.map((e) => e.rule);
    expect(rules).toContain("breaking_change_skip_row");
    // lldd_invalid suppressed to avoid duplicate UI noise — the
    // org admin's remediation is "wait for config", not "fix data"
    expect(rules).not.toContain("lldd_invalid");
  });

  it("W1 — non_regulated aim with AddHours > 0 → warning + autofix to 0", async () => {
    const row = makeRow({
      AddHours: 12,
      _suppression_notes: ["AddHours suppressed: esol_aim_type=non_regulated"],
    });
    const out = await validateRows([row], ACADEMIC_YEAR);
    expect(out.valid_rows).toHaveLength(1);
    // Row mutated in place
    expect(out.valid_rows[0].AddHours).toBe(0);
    const warning = out.warnings.find((w) => w.issue.rule === "add_hours_on_non_regulated");
    expect(warning).toBeDefined();
    expect(warning!.issue.severity).toBe("warning");
    expect(warning!.issue.message).toMatch(/Auto-corrected/);
  });

  it("W2 — postcode not in DfE dataset → warning, row still valid", async () => {
    postcodeLookupMock.mockResolvedValue(null); // not in dataset
    const row = makeRow({ PostcodePrior: "ZZ99 9ZZ" });
    const out = await validateRows([row], ACADEMIC_YEAR);
    expect(out.valid_rows).toHaveLength(1);
    const warning = out.warnings.find(
      (w) => w.issue.rule === "postcode_not_in_dfe_dataset",
    );
    expect(warning).toBeDefined();
    expect(warning!.issue.message).toMatch(/ZZ99 9ZZ.*not found/);
  });

  it("W2.b — distinct postcodes are deduped (one Redis call per postcode)", async () => {
    const rows = [
      makeRow({ PostcodePrior: "AA1 1AA" }),
      makeRow({ PostcodePrior: "AA1 1AA" }),
      makeRow({ PostcodePrior: "AA1 1AA" }),
      makeRow({ PostcodePrior: "BB2 2BB" }),
    ];
    await validateRows(rows, ACADEMIC_YEAR);
    expect(postcodeLookupMock).toHaveBeenCalledTimes(2);
  });

  it("W3 — zero-session learner enrolled > 30 days ago → warning", async () => {
    const learner_stubs = [
      {
        learner_id: "111111111111111111111111",
        enrolled_at: new Date(Date.now() - 45 * 24 * 60 * 60 * 1000), // 45d ago
        has_any_session: false,
      },
      {
        learner_id: "222222222222222222222222",
        enrolled_at: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000), // 10d ago
        has_any_session: false, // recent enrolment — no warning
      },
      {
        learner_id: "333333333333333333333333",
        enrolled_at: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000),
        has_any_session: true, // has session — no warning
      },
    ];
    const out = await validateRows([], ACADEMIC_YEAR, { learner_stubs });
    expect(out.warnings).toHaveLength(1);
    expect(out.warnings[0].learner_id).toBe("111111111111111111111111");
    expect(out.warnings[0].issue.rule).toBe("no_sessions_stale_learner");
    expect(out.warnings[0].issue.message).toMatch(/45 days ago/);
  });

  it("Mix — a cohort of 10 mixed-validity rows produces a sensible output", async () => {
    postcodeLookupMock.mockImplementation(async (pc: string) =>
      pc === "ZZ99 9ZZ" ? null : { sof: "105", ldm: null, mca: null },
    );

    const baseLearners = Array.from({ length: 10 }, (_, i) =>
      new Types.ObjectId().toString(),
    );
    const baseSessions = Array.from({ length: 10 }, (_, i) =>
      new Types.ObjectId().toString(),
    );
    const stamp = (i: number) => ({
      _learner_id: baseLearners[i],
      _session_id: baseSessions[i],
    });

    const cohort: IlrRow[] = [
      // 1–5: clean
      makeRow({ ...stamp(0) }),
      makeRow({ ...stamp(1), Sex: 1, GivenNames: "Ahmed" }),
      makeRow({ ...stamp(2), Sex: 2, GivenNames: "Beatrice" }),
      makeRow({ ...stamp(3), LLDDHealthProb: 1 }),
      makeRow({ ...stamp(4), LLDDHealthProb: 2 }),
      // 6: invalid ULN (blocks)
      makeRow({ ...stamp(5), ULN: "ABC" }),
      // 7: missing SOF (blocks)
      makeRow({
        ...stamp(6),
        SOF: null,
        _warnings: [{ type: "sof_code_missing" }],
      }),
      // 8: LLDD null (blocks)
      makeRow({ ...stamp(7), LLDDHealthProb: null }),
      // 9: postcode not in DfE (warns, still valid)
      makeRow({ ...stamp(8), PostcodePrior: "ZZ99 9ZZ" }),
      // 10: AddHours on non_regulated (warns, autofixed)
      makeRow({
        ...stamp(9),
        AddHours: 8,
        _suppression_notes: ["AddHours suppressed: esol_aim_type=non_regulated"],
      }),
    ];

    const out = await validateRows(cohort, ACADEMIC_YEAR);
    expect(out.valid_rows).toHaveLength(7);     // 5 clean + 2 warned-but-valid
    expect(out.blocked_rows).toHaveLength(3);
    // Warnings include the 3 errors + the 2 soft warnings = 5
    expect(out.warnings.length).toBeGreaterThanOrEqual(5);

    // Check the auto-correction landed on row 10
    const fixed = out.valid_rows.find((r) => r._learner_id === baseLearners[9]);
    expect(fixed?.AddHours).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════════════
// runIlrExport — idempotency + warnings cache
// ═════════════════════════════════════════════════════════════════════

describe("runIlrExport", () => {
  const createOrg = async () =>
    Organisation.create({
      name: "Run Org",
      slug: `run-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      contactEmail: "admin@run.local",
      adminUserId: new Types.ObjectId(),
      billing_active: true,
      isActive: true,
    });

  const createLearner = async (orgId: unknown, overrides: Record<string, unknown> = {}) =>
    User.create({
      firstname: "Run", lastname: "Learner",
      email: `r-${Date.now()}-${Math.random().toString(16).slice(2)}@run.local`,
      password: "x", phoneNumber: "07000000000",
      role: "student", orgId,
      isActive: true, status: "active", verified: true,
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
      ...overrides,
    });

  const seedSession = (learnerId: unknown, orgId: unknown) =>
    AISession.create({
      learnerId, orgId,
      sessionMode: "BRIDGE", esolLevel: "e2",
      turns: [], safeguardingFlagged: false, vocabIntroduced: [],
      session_source: "ai_tutor", duration_mins: 60,
      turn_scores: [], teaching_mode_sequence: [],
      start_time: new Date("2025-11-01T10:00:00Z"),
    });

  beforeEach(async () => {
    await seedConfig();
  });

  it("Idem.key — sha256 of (org, year, period_start, period_end) is stable + sensitive", () => {
    const k1 = computeExportIdempotencyKey({
      org_id: "111111111111111111111111",
      academic_year: "2025/26",
      period_start: "2025-08-01",
      period_end: "2026-07-31",
    });
    const k2 = computeExportIdempotencyKey({
      org_id: "111111111111111111111111",
      academic_year: "2025/26",
      period_start: "2025-08-01",
      period_end: "2026-07-31",
    });
    expect(k1).toBe(k2);
    expect(k1).toMatch(/^[0-9a-f]{64}$/);
    // Different period_end → different key
    const k3 = computeExportIdempotencyKey({
      org_id: "111111111111111111111111",
      academic_year: "2025/26",
      period_start: "2025-08-01",
      period_end: "2026-07-30",
    });
    expect(k3).not.toBe(k1);
  });

  it("Idem.cache — second call with same input returns cache_hit: true", async () => {
    const org = await createOrg();
    const learner = await createLearner(org._id);
    await seedSession(learner._id, org._id);

    const input = {
      org_id: org._id.toString(),
      academic_year: ACADEMIC_YEAR,
      period_start: "2025-08-01",
      period_end: "2026-07-31",
    };
    const first = await runIlrExport(input);
    expect(first.cache_hit).toBe(false);
    expect(first.valid_rows.length).toBeGreaterThan(0);

    const second = await runIlrExport(input);
    expect(second.cache_hit).toBe(true);
    expect(second.export_id).toBe(first.export_id);
    expect(second.valid_rows.length).toBe(first.valid_rows.length);
  });

  it("Idem.distinct — different period → new export, not cached", async () => {
    const org = await createOrg();
    const learner = await createLearner(org._id);
    await seedSession(learner._id, org._id);

    const a = await runIlrExport({
      org_id: org._id.toString(),
      academic_year: ACADEMIC_YEAR,
      period_start: "2025-08-01",
      period_end: "2026-07-31",
    });
    const b = await runIlrExport({
      org_id: org._id.toString(),
      academic_year: ACADEMIC_YEAR,
      period_start: "2025-08-01",
      period_end: "2026-01-31", // ← different
    });
    expect(a.export_id).not.toBe(b.export_id);
    expect(b.cache_hit).toBe(false);
  });

  it("Cache — warnings persisted to IlrExportWarnings with TTL on created_at", async () => {
    const org = await createOrg();
    // Seed a learner with an invalid ULN so a warning fires
    const learner = await createLearner(org._id, { uln: "BAD" });
    await seedSession(learner._id, org._id);

    const result = await runIlrExport({
      org_id: org._id.toString(),
      academic_year: ACADEMIC_YEAR,
      period_start: "2025-08-01",
      period_end: "2026-07-31",
    });

    const cached = await IlrExportWarnings.findOne({
      export_id: result.export_id,
    }).lean();
    expect(cached).toBeTruthy();
    expect(cached?.warnings.length).toBe(result.warnings.length);
    expect(cached?.org_id.toString()).toBe(org._id.toString());

    // TTL index — IlrExportWarnings model declares 604,800s on created_at
    const idx = await IlrExportWarnings.collection.indexes();
    const ttlIdx = idx.find(
      (i) => "expireAfterSeconds" in (i as Record<string, unknown>),
    );
    expect(ttlIdx).toBeDefined();
    expect((ttlIdx as { expireAfterSeconds: number }).expireAfterSeconds).toBe(
      604_800,
    );
  });

  it("Bad input — invalid year / period format throws", async () => {
    await expect(
      runIlrExport({
        org_id: "abc",
        academic_year: "2025-26", // dash, not slash
        period_start: "2025-08-01",
        period_end: "2026-07-31",
      }),
    ).rejects.toThrow();
    await expect(
      runIlrExport({
        org_id: "111111111111111111111111",
        academic_year: ACADEMIC_YEAR,
        period_start: "01/08/2025",
        period_end: "2026-07-31",
      }),
    ).rejects.toThrow();
  });
});
