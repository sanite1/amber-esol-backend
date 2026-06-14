/**
 * Tests for src/services/ilrExport.service.ts — brief Function 13 To-Do 1.
 *
 * The brief is emphatic that the mapper carries zero hardcoded ILR
 * knowledge. These tests prove it by swapping the config and watching
 * the output change.
 *
 *   F1   formatIlrDate — Date / ISO string / null
 *   F2   minutesToHours — 1dp rounding
 *   F3   formatSex — only 1 or 2 pass through
 *   F4   remapLlddt — expired-with-remap → target; expired-no-remap → null
 *   F5   validateSofCode — whitelist gate
 *   F6   decideAddHours — suppression rule drives the output
 *   F7   resolveLearnAimRefForLevel — esol_level_to_aim_ref lookup
 *   F8   resolveEnglishProgType — config-driven per aim_type
 *
 *   I1   buildIlrRows: config missing → empty + config_missing: true
 *   I2   One row per learner-session; AimSeqNumber resets per learner
 *   I3   FundModel / AimType / SOF / LLDDHealthProb all read from config
 *   I4   Swapping the config swaps the output values
 *   I5   LearnAimRef validated against FALACache — invalid → _aim_invalid
 *   I6   L2 + passed → CompStatus 2, Outcome 1, LearnActEndDate set
 *   I7   isActive=false → CompStatus 3, Outcome 3 (withdrawn)
 *   I8   AddHours suppression when esol_aim_type=non_regulated
 */

process.env.REFERRAL_JWT_SECRET =
  process.env.REFERRAL_JWT_SECRET ?? "test-secret";

// FALACache uses Redis — mock isValidAim so tests don't need Redis.
const falaIsValidMock = jest.fn();
jest.mock("../services/falaCache.service", () => ({
  __esModule: true,
  default: { isValidAim: (...args: unknown[]) => falaIsValidMock(...args) },
}));

import { Types } from "mongoose";
import Organisation from "../models/Organisation";
import User from "../models/User";
import AISession from "../models/AISession";
import ComplianceConfig from "../models/ComplianceConfig";
import ComplianceConfigService from "../services/ComplianceConfigService";
import {
  buildIlrRows,
  formatIlrDate,
  minutesToHours,
  formatSex,
  remapLlddt,
  validateSofCode,
  __internals__,
} from "../services/ilrExport.service";

// ─────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────

const ACADEMIC_YEAR = "2025/26";

const seedConfig = async (overrides: Partial<Record<string, unknown>> = {}) => {
  await ComplianceConfig.deleteMany({
    domain: "ilr",
    academic_year: ACADEMIC_YEAR,
  });
  const rules = {
    field_name_overrides: { SOC2000: "SOC" },
    valid_sof_codes: ["105", "107"],
    expired_llddt_codes: ["97"],
    llddt_remapping: { "97": 9 },
    fund_model: 38,
    aim_type_default: 4,
    esol_level_to_aim_ref: {
      e1: "60139560",
      e2: "60139572",
      e3: "60139584",
      l1: "60139596",
      l2: "60139603",
    },
    english_prog_type: { regulated: 25, non_regulated: null },
    add_hours_suppression_rule: {
      regulated: "claim",
      non_regulated: "suppress",
      missing: "suppress",
    },
    valid_dam_codes: ["SOF", "ACT", "RES"],
    ...overrides,
  };
  await ComplianceConfig.create({
    domain: "ilr",
    academic_year: ACADEMIC_YEAR,
    version: 1,
    active: true,
    rules,
    updated_by: null,
    updated_at: new Date(),
    changelog: "test seed",
  });
  await ComplianceConfigService.loadAll();
};

const createOrg = async () =>
  Organisation.create({
    name: "ILR Org",
    slug: `ilr-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    contactEmail: "admin@ilr.local",
    adminUserId: new Types.ObjectId(),
    billing_active: true,
    isActive: true,
  });

interface LearnerOpts {
  orgId: unknown;
  firstname?: string;
  lastname?: string;
  dateOfBirth?: Date;
  sex?: 1 | 2 | null;
  ethnicity?: string;
  lldd_health_prob?: number | null;
  esolOnboardedAt?: Date;
  postcode_prior?: string;
  uln?: string;
  sof_code?: string | null;
  esol_aim_type?: "regulated" | "non_regulated" | null;
  esolLevel?: string;
  glh_teacher_contact?: number;
  isActive?: boolean;
}
const createLearner = async (opts: LearnerOpts) =>
  User.create({
    firstname: opts.firstname ?? "First",
    lastname: opts.lastname ?? "Last",
    email: `i-${Date.now()}-${Math.random().toString(16).slice(2)}@ilr.local`,
    password: "x",
    phoneNumber: "07000000000",
    role: "student",
    orgId: opts.orgId,
    isActive: opts.isActive ?? true,
    status: "active",
    verified: true,
    dateOfBirth: opts.dateOfBirth ?? new Date("1990-05-15"),
    sex: opts.sex ?? 1,
    ethnicity: opts.ethnicity ?? "31",
    lldd_health_prob: opts.lldd_health_prob ?? null,
    esolOnboardedAt: opts.esolOnboardedAt ?? new Date("2025-09-01"),
    postcode_prior: opts.postcode_prior ?? "NE1 1AA",
    uln: opts.uln ?? "9999999999",
    sof_code: opts.sof_code ?? "105",
    esol_aim_type: opts.esol_aim_type ?? "regulated",
    esolLevel: opts.esolLevel ?? "e2",
    glh_teacher_contact: opts.glh_teacher_contact ?? 0,
  });

const seedSession = async (
  learnerId: unknown,
  orgId: unknown,
  args: {
    source?: "ai_tutor" | "teacher_consolidation" | "pre_platform";
    durationMins?: number;
    passed?: boolean | null;
    createdAt?: Date;
    completedAt?: Date;
    startTime?: Date;
    skillCodes?: string[];
  } = {},
) => {
  const s = await AISession.create({
    learnerId,
    orgId,
    sessionMode: "BRIDGE",
    esolLevel: "e2",
    turns: [],
    safeguardingFlagged: false,
    vocabIntroduced: [],
    session_source: args.source ?? "ai_tutor",
    duration_mins: args.durationMins ?? 60,
    passed: args.passed ?? null,
    skill_codes_covered: args.skillCodes ?? ["Sc", "Lr"],
    turn_scores: [],
    teaching_mode_sequence: [],
    start_time: args.startTime ?? new Date("2025-10-01T10:00:00Z"),
    completedAt: args.completedAt ?? null,
  });
  if (args.createdAt) {
    await AISession.collection.updateOne(
      { _id: s._id as unknown as never },
      { $set: { createdAt: args.createdAt } },
    );
  }
  return s;
};

beforeEach(() => {
  falaIsValidMock.mockReset();
  // Default: every aim ref is valid. Individual tests override.
  falaIsValidMock.mockResolvedValue(true);
});

// ═════════════════════════════════════════════════════════════════════
// F1–F8 — Pure formatters / lookups
// ═════════════════════════════════════════════════════════════════════

describe("pure formatters / lookups", () => {
  it("F1 — formatIlrDate", () => {
    expect(formatIlrDate(new Date("2026-03-14T15:09:26Z"))).toBe("2026-03-14");
    expect(formatIlrDate("2026-03-14T00:00:00.000Z")).toBe("2026-03-14");
    expect(formatIlrDate(null)).toBeNull();
    expect(formatIlrDate(undefined)).toBeNull();
    expect(formatIlrDate("not a date")).toBeNull();
  });

  it("F2 — minutesToHours rounds to 1dp", () => {
    expect(minutesToHours(60)).toBe(1.0);
    expect(minutesToHours(90)).toBe(1.5);
    expect(minutesToHours(45)).toBe(0.8); // 0.75 → 0.8
    expect(minutesToHours(null)).toBe(0);
    expect(minutesToHours(undefined)).toBe(0);
  });

  it("F3 — formatSex only passes through 1 or 2", () => {
    expect(formatSex(1)).toBe(1);
    expect(formatSex(2)).toBe(2);
    expect(formatSex(0)).toBeNull();
    expect(formatSex(null)).toBeNull();
    expect(formatSex(undefined)).toBeNull();
  });

  it("F4 — remapLlddt: expired-with-remap → target; expired-no-remap → null", () => {
    const expired = ["97"];
    const remap = { "97": 9 };
    expect(remapLlddt(97, expired, remap)).toBe(9);
    expect(remapLlddt("97", expired, remap)).toBe(9);
    expect(remapLlddt(99, expired, remap)).toBe(99); // not expired
    expect(remapLlddt(97, ["97"], {})).toBeNull(); // expired, no remap
    expect(remapLlddt(null, expired, remap)).toBeNull();
  });

  it("F5 — validateSofCode whitelists", () => {
    expect(validateSofCode("105", ["105", "107"])).toBe("105");
    expect(validateSofCode("106", ["105", "107"])).toBeNull();
    expect(validateSofCode(null, ["105"])).toBeNull();
  });

  it("F6 — decideAddHours: suppress when rule says so", () => {
    const rule = {
      regulated: "claim" as const,
      non_regulated: "suppress" as const,
      missing: "suppress" as const,
    };
    expect(__internals__.decideAddHours("regulated", 4.5, rule).addHours).toBe(
      4.5,
    );
    expect(
      __internals__.decideAddHours("non_regulated", 4.5, rule).addHours,
    ).toBeNull();
    expect(__internals__.decideAddHours(null, 4.5, rule).addHours).toBeNull();
  });

  it("F7 — resolveLearnAimRefForLevel uses esol_level_to_aim_ref map", () => {
    const map = { e1: "ref-e1", e2: "ref-e2" };
    expect(__internals__.resolveLearnAimRefForLevel("e2", map)).toBe("ref-e2");
    expect(__internals__.resolveLearnAimRefForLevel("L1", map)).toBeNull(); // case + missing
    expect(__internals__.resolveLearnAimRefForLevel(null, map)).toBeNull();
    expect(
      __internals__.resolveLearnAimRefForLevel("e1", undefined),
    ).toBeNull();
  });

  it("F8 — resolveEnglishProgType is config-driven", () => {
    const rules = { regulated: 25, non_regulated: null };
    expect(__internals__.resolveEnglishProgType("regulated", rules)).toBe(25);
    expect(
      __internals__.resolveEnglishProgType("non_regulated", rules),
    ).toBeNull();
    expect(__internals__.resolveEnglishProgType(null, rules)).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════
// I1–I8 — Integration over Mongo + ComplianceConfig + FALA
// ═════════════════════════════════════════════════════════════════════

describe("buildIlrRows integration", () => {
  it("I1 — no compliance config → empty result with config_missing: true", async () => {
    await ComplianceConfig.deleteMany({ domain: "ilr" });
    await ComplianceConfigService.loadAll();
    const org = await createOrg();
    await createLearner({ orgId: org._id });

    const out = await buildIlrRows(org._id.toString(), ACADEMIC_YEAR);
    expect(out.config_missing).toBe(true);
    expect(out.rows).toHaveLength(0);
  });

  it("I2 — one row per session; AimSeqNumber resets per learner", async () => {
    await seedConfig();
    const org = await createOrg();
    const learnerA = await createLearner({ orgId: org._id, firstname: "A" });
    const learnerB = await createLearner({ orgId: org._id, firstname: "B" });
    await seedSession(learnerA._id, org._id, { source: "ai_tutor" });
    await seedSession(learnerA._id, org._id, { source: "pre_platform" });
    await seedSession(learnerA._id, org._id, {
      source: "teacher_consolidation",
    });
    await seedSession(learnerB._id, org._id, { source: "ai_tutor" });

    const out = await buildIlrRows(org._id.toString(), ACADEMIC_YEAR);
    expect(out.rows).toHaveLength(4);

    const aRows = out.rows.filter(
      (r) => r._learner_id === learnerA._id.toString(),
    );
    expect(aRows.map((r) => r.AimSeqNumber)).toEqual([1, 2, 3]);

    const bRows = out.rows.filter(
      (r) => r._learner_id === learnerB._id.toString(),
    );
    expect(bRows.map((r) => r.AimSeqNumber)).toEqual([1]);
  });

  it("I3 — FundModel / AimType / SOF / LLDDHealthProb / EnglishProgType all read from config", async () => {
    await seedConfig();
    const org = await createOrg();
    const learner = await createLearner({
      orgId: org._id,
      sof_code: "105",
      esol_aim_type: "regulated",
    });
    // Bypass schema enum to seed a legacy LLDDT code that the remap
    // is supposed to translate. The schema enum is the live one;
    // the remap exists precisely to handle codes the enum no longer
    // accepts but that historical data still carries.
    await User.collection.updateOne(
      { _id: learner._id as unknown as never },
      { $set: { lldd_health_prob: 97 } },
    );
    await seedSession(learner._id, org._id);

    const out = await buildIlrRows(org._id.toString(), ACADEMIC_YEAR);
    const row = out.rows[0];
    expect(row.FundModel).toBe(38);
    expect(row.AimType).toBe(4);
    expect(row.SOF).toBe("105");
    expect(row.LLDDHealthProb).toBe(9);
    // EnglishProgType is now a STRING (2025/26 codes may be
    // alphanumeric). Source priority is User.english_prog_type →
    // config.english_prog_type_default → hard "25". The fixture
    // sets neither, so this lands on the hard default with a
    // `english_prog_type_defaulted` warning.
    expect(row.EnglishProgType).toBe("25");
    expect(row._warnings).toContainEqual({
      type: "english_prog_type_defaulted",
      defaulted_to: "25",
    });
  });

  it("I4 — swapping the config swaps the output (no hardcoded ILR knowledge)", async () => {
    const org = await createOrg();
    const learner = await createLearner({
      orgId: org._id,
      sof_code: "999", // not on default whitelist
    });
    await seedSession(learner._id, org._id);

    // Spec A — defaults
    await seedConfig();
    const outA = await buildIlrRows(org._id.toString(), ACADEMIC_YEAR);
    expect(outA.rows[0].FundModel).toBe(38);
    expect(outA.rows[0].AimType).toBe(4);
    expect(outA.rows[0].SOF).toBeNull(); // 999 not on whitelist

    // Spec B — DfE pivots: new FundModel + new AimType + 999 now valid
    await seedConfig({
      fund_model: 99,
      aim_type_default: 7,
      valid_sof_codes: ["999"],
    });
    const outB = await buildIlrRows(org._id.toString(), ACADEMIC_YEAR);
    expect(outB.rows[0].FundModel).toBe(99);
    expect(outB.rows[0].AimType).toBe(7);
    expect(outB.rows[0].SOF).toBe("999");
  });

  it("I5 — LearnAimRef validated against FALA; invalid → _aim_invalid", async () => {
    await seedConfig();
    const org = await createOrg();
    const learnerOk = await createLearner({ orgId: org._id, esolLevel: "e2" });
    const learnerBad = await createLearner({ orgId: org._id, esolLevel: "e3" });
    await seedSession(learnerOk._id, org._id);
    await seedSession(learnerBad._id, org._id);

    // E2 ref valid, E3 ref invalid
    falaIsValidMock.mockImplementation(
      async (ref: string) => ref === "60139572",
    );

    const out = await buildIlrRows(org._id.toString(), ACADEMIC_YEAR);
    const okRow = out.rows.find(
      (r) => r._learner_id === learnerOk._id.toString(),
    );
    const badRow = out.rows.find(
      (r) => r._learner_id === learnerBad._id.toString(),
    );
    expect(okRow!._aim_invalid).toBe(false);
    expect(badRow!._aim_invalid).toBe(true);
    expect(badRow!._suppression_notes.join(" ")).toMatch(/FALA whitelist/);
    expect(out.aim_invalid_rows).toHaveLength(1);
  });

  it("I6 — L2 + passed → CompStatus 2, Outcome 1, LearnActEndDate set", async () => {
    await seedConfig();
    const org = await createOrg();
    const learner = await createLearner({ orgId: org._id, esolLevel: "l2" });
    const completed = new Date("2026-05-15T10:00:00Z");
    await seedSession(learner._id, org._id, {
      passed: true,
      completedAt: completed,
    });

    const out = await buildIlrRows(org._id.toString(), ACADEMIC_YEAR);
    const row = out.rows[0];
    expect(row.CompStatus).toBe(2);
    expect(row.Outcome).toBe(1);
    expect(row.LearnActEndDate).toBe("2026-05-15");
  });

  it("I7 — withdrawn learner (isActive=false) → CompStatus 3, Outcome 3", async () => {
    await seedConfig();
    const org = await createOrg();
    const learner = await createLearner({
      orgId: org._id,
      esolLevel: "e2",
      isActive: false,
    });
    await seedSession(learner._id, org._id, {
      completedAt: new Date("2026-02-10T10:00:00Z"),
    });

    const out = await buildIlrRows(org._id.toString(), ACADEMIC_YEAR);
    const row = out.rows[0];
    expect(row.CompStatus).toBe(3);
    expect(row.Outcome).toBe(3);
    expect(row.LearnActEndDate).toBe("2026-02-10");
  });

  it("I8 — non_regulated aim → AddHours suppressed with note", async () => {
    await seedConfig();
    const org = await createOrg();
    const reg = await createLearner({
      orgId: org._id,
      esol_aim_type: "regulated",
      glh_teacher_contact: 4.5,
    });
    const nonReg = await createLearner({
      orgId: org._id,
      esol_aim_type: "non_regulated",
      glh_teacher_contact: 4.5,
    });
    await seedSession(reg._id, org._id, { durationMins: 60 });
    await seedSession(nonReg._id, org._id, { durationMins: 60 });

    const out = await buildIlrRows(org._id.toString(), ACADEMIC_YEAR);
    const regRow = out.rows.find((r) => r._learner_id === reg._id.toString())!;
    const nonRegRow = out.rows.find(
      (r) => r._learner_id === nonReg._id.toString(),
    )!;

    expect(regRow.AddHours).toBeGreaterThan(0); // 1 + 4.5 = 5.5
    expect(nonRegRow.AddHours).toBeNull();
    expect(nonRegRow._suppression_notes.join(" ")).toMatch(
      /AddHours suppressed/,
    );
  });

  it("I9 — dates always formatted YYYY-MM-DD; NINumber blank", async () => {
    await seedConfig();
    const org = await createOrg();
    const learner = await createLearner({
      orgId: org._id,
      dateOfBirth: new Date("1985-06-22T08:00:00Z"),
      esolOnboardedAt: new Date("2025-09-10T11:00:00Z"),
    });
    await seedSession(learner._id, org._id, {
      startTime: new Date("2025-11-03T09:00:00Z"),
    });

    const out = await buildIlrRows(org._id.toString(), ACADEMIC_YEAR);
    const row = out.rows[0];
    expect(row.DateOfBirth).toBe("1985-06-22");
    expect(row.LearnerEntryDate).toBe("2025-09-10");
    expect(row.LearnStartDate).toBe("2025-11-03");
    expect(row.NINumber).toBe("");
  });
});
