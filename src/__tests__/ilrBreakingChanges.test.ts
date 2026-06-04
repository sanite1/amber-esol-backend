/**
 * 2025/26 ILR breaking-change handlers — brief Function 13 To-Do 2.
 *
 * Four discrete handlers, four test groups. The handlers are pure
 * functions over the config rules; these tests pin their behaviour
 * without spinning up Mongo + Redis.
 *
 *   §1 handleSofCode             SOF code 19-route mapping
 *   §2 handleEnglishProgType     EnglishProgType per-learner (was derivable)
 *   §3 applyFieldNameOverrides   SOC2000 → SOC field rename
 *   §4 handleExpiredLlddt        LLDDT code 15 expired
 *
 * Plus integration tests (§I) that drive the row builder through all
 * four handlers at once and assert the warnings + skipRow propagate
 * end-to-end.
 */

process.env.REFERRAL_JWT_SECRET = process.env.REFERRAL_JWT_SECRET ?? "test-secret";

// FALACache stub — irrelevant to these handler tests but the row
// builder integration calls it. Always-valid keeps the tests focused.
jest.mock("../services/falaCache.service", () => ({
  __esModule: true,
  default: { isValidAim: jest.fn().mockResolvedValue(true) },
}));

import { Types } from "mongoose";
import Organisation from "../models/Organisation";
import User from "../models/User";
import AISession from "../models/AISession";
import ComplianceConfig from "../models/ComplianceConfig";
import ComplianceConfigService from "../services/ComplianceConfigService";
import {
  buildIlrRows,
  breakingChangeHandleSofCode as handleSofCode,
  breakingChangeHandleEnglishProgType as handleEnglishProgType,
  breakingChangeApplyFieldNameOverrides as applyFieldNameOverrides,
  breakingChangeHandleExpiredLlddt as handleExpiredLlddt,
} from "../services/ilrExport.service";

const ACADEMIC_YEAR = "2025/26";

// ═════════════════════════════════════════════════════════════════════
// §1 — handleSofCode (SOF 19-route validation)
// ═════════════════════════════════════════════════════════════════════

describe("§1 handleSofCode — SOF 19-route validation (Function 13 To-Do 2.1)", () => {
  const VALID = ["105", "107", "108"] as const;

  it("on-whitelist code → value passes through, no warning", () => {
    expect(handleSofCode("105", VALID)).toEqual({
      value: "105",
      warning: null,
    });
  });

  it("off-whitelist code → value nulled + sof_code_invalid warning", () => {
    expect(handleSofCode("999", VALID)).toEqual({
      value: null,
      warning: { type: "sof_code_invalid", code: "999" },
    });
  });

  it("missing / empty / null → sof_code_missing warning (no value to ship)", () => {
    expect(handleSofCode(null, VALID)).toEqual({
      value: null,
      warning: { type: "sof_code_missing" },
    });
    expect(handleSofCode(undefined, VALID)).toEqual({
      value: null,
      warning: { type: "sof_code_missing" },
    });
    expect(handleSofCode("", VALID)).toEqual({
      value: null,
      warning: { type: "sof_code_missing" },
    });
    expect(handleSofCode("   ", VALID)).toEqual({
      value: null,
      warning: { type: "sof_code_missing" },
    });
  });

  it("whitelist is config-driven — swap the whitelist, watch the validity flip", () => {
    expect(handleSofCode("999", ["105"]).warning).toEqual({
      type: "sof_code_invalid",
      code: "999",
    });
    // Same code, different whitelist → now valid, no warning.
    expect(handleSofCode("999", ["999"])).toEqual({
      value: "999",
      warning: null,
    });
  });
});

// ═════════════════════════════════════════════════════════════════════
// §2 — handleEnglishProgType (per-learner explicit field)
// ═════════════════════════════════════════════════════════════════════

describe("§2 handleEnglishProgType — per-learner explicit field (Function 13 To-Do 2.2)", () => {
  it("learner has explicit value → pass through, no warning", () => {
    expect(handleEnglishProgType("25", "99")).toEqual({
      value: "25",
      warning: null,
    });
    // Non-numeric (future spec) — handler is string-typed
    expect(handleEnglishProgType("25A", "99")).toEqual({
      value: "25A",
      warning: null,
    });
  });

  it("learner has no value, config default present → default + warning", () => {
    expect(handleEnglishProgType(null, "27")).toEqual({
      value: "27",
      warning: {
        type: "english_prog_type_defaulted",
        defaulted_to: "27",
      },
    });
  });

  it("neither learner nor config has a value → hard fallback '25' + warning", () => {
    expect(handleEnglishProgType(null, undefined)).toEqual({
      value: "25",
      warning: {
        type: "english_prog_type_defaulted",
        defaulted_to: "25",
      },
    });
    expect(handleEnglishProgType("", undefined)).toEqual({
      value: "25",
      warning: {
        type: "english_prog_type_defaulted",
        defaulted_to: "25",
      },
    });
  });

  it("whitespace-only learner value is treated as empty", () => {
    expect(handleEnglishProgType("   ", "27").value).toBe("27");
  });
});

// ═════════════════════════════════════════════════════════════════════
// §3 — applyFieldNameOverrides (SOC2000 → SOC field rename)
// ═════════════════════════════════════════════════════════════════════

describe("§3 applyFieldNameOverrides — SOC2000 → SOC field rename (Function 13 To-Do 2.3)", () => {
  const overrides = { SOC2000: "SOC", LLDDHealthProb: "LLDD" } as const;

  it("renames a mapped name", () => {
    expect(applyFieldNameOverrides("SOC2000", overrides)).toBe("SOC");
    expect(applyFieldNameOverrides("LLDDHealthProb", overrides)).toBe("LLDD");
  });

  it("passes through unmapped names unchanged", () => {
    expect(applyFieldNameOverrides("ULN", overrides)).toBe("ULN");
    expect(applyFieldNameOverrides("FamilyName", overrides)).toBe("FamilyName");
  });

  it("undefined overrides map → no rename", () => {
    expect(applyFieldNameOverrides("SOC2000", undefined)).toBe("SOC2000");
  });

  it("empty overrides map → no rename", () => {
    expect(applyFieldNameOverrides("SOC2000", {})).toBe("SOC2000");
  });

  it("works for a full row's worth of headers", () => {
    const canonicalHeaders = ["ULN", "SOC2000", "LearnAimRef", "LLDDHealthProb"];
    const emitted = canonicalHeaders.map((h) =>
      applyFieldNameOverrides(h, overrides),
    );
    expect(emitted).toEqual(["ULN", "SOC", "LearnAimRef", "LLDD"]);
  });
});

// ═════════════════════════════════════════════════════════════════════
// §4 — handleExpiredLlddt (LLDDT code 15 expired)
// ═════════════════════════════════════════════════════════════════════

describe("§4 handleExpiredLlddt — LLDDT code 15 expired (Function 13 To-Do 2.4)", () => {
  const EXPIRED = ["15", "16"] as const;
  const REMAP: Record<string, number> = { "15": 9, "16": 8 };

  it("expired-with-remap → remap target + llddt_remapped warning, no skip", () => {
    expect(handleExpiredLlddt(15, EXPIRED, REMAP)).toEqual({
      value: 9,
      warning: { type: "llddt_remapped", from: "15", to: "9" },
      skipRow: false,
    });
    // String coercion also covered
    expect(handleExpiredLlddt("15", EXPIRED, REMAP)).toEqual({
      value: 9,
      warning: { type: "llddt_remapped", from: "15", to: "9" },
      skipRow: false,
    });
  });

  it("expired with NO remap → null value + llddt_blocked warning + skipRow", () => {
    expect(handleExpiredLlddt("15", EXPIRED, {})).toEqual({
      value: null,
      warning: { type: "llddt_blocked", code: "15" },
      skipRow: true,
    });
  });

  it("non-expired code → pass through, no warning, no skip", () => {
    expect(handleExpiredLlddt(9, EXPIRED, REMAP)).toEqual({
      value: 9,
      warning: null,
      skipRow: false,
    });
  });

  it("null / undefined input → null value, no warning, no skip", () => {
    expect(handleExpiredLlddt(null, EXPIRED, REMAP)).toEqual({
      value: null,
      warning: null,
      skipRow: false,
    });
    expect(handleExpiredLlddt(undefined, EXPIRED, REMAP)).toEqual({
      value: null,
      warning: null,
      skipRow: false,
    });
  });

  it("remap target that isn't a number → blocked + skipRow", () => {
    // A malformed config that points an expired code at a non-numeric
    // target is treated as no remap — the handler refuses to ship a
    // garbage value.
    expect(handleExpiredLlddt("15", ["15"], { "15": "not-a-number" })).toEqual({
      value: null,
      warning: { type: "llddt_blocked", code: "15" },
      skipRow: true,
    });
  });
});

// ═════════════════════════════════════════════════════════════════════
// §I — Integration through buildIlrRows
// ═════════════════════════════════════════════════════════════════════

describe("§I — handlers wired through buildIlrRows", () => {
  // Bare-minimum config covering all four breaking-change rules.
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
      name: "BC Org",
      slug: `bc-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      contactEmail: "admin@bc.local",
      adminUserId: new Types.ObjectId(),
      billing_active: true,
      isActive: true,
    });

  const createLearner = async (
    orgId: unknown,
    extras: Partial<{
      sof_code: string | null;
      english_prog_type: string | null;
      lldd_health_prob: number | null;
      esol_aim_type: "regulated" | "non_regulated";
    }> = {},
  ) => {
    const learner = await User.create({
      firstname: "BC", lastname: "Learner",
      email: `bc-${Date.now()}-${Math.random().toString(16).slice(2)}@bc.local`,
      password: "x", phoneNumber: "07000000000",
      role: "student", orgId,
      isActive: true, status: "active", verified: true,
      dateOfBirth: new Date("1990-01-01"),
      sex: 1,
      esolOnboardedAt: new Date("2025-09-01"),
      uln: "9999999999",
      esol_aim_type: extras.esol_aim_type ?? "regulated",
      esolLevel: "e2",
      sof_code: extras.sof_code === undefined ? "105" : extras.sof_code,
      english_prog_type:
        extras.english_prog_type === undefined ? null : extras.english_prog_type,
    });
    // Bypass schema enum for expired LLDDT codes — the whole point
    // of §4 is handling legacy codes the live enum no longer accepts.
    if (extras.lldd_health_prob !== undefined) {
      await User.collection.updateOne(
        { _id: learner._id as unknown as never },
        { $set: { lldd_health_prob: extras.lldd_health_prob } },
      );
    }
    return learner;
  };

  const seedSession = (learnerId: unknown, orgId: unknown) =>
    AISession.create({
      learnerId, orgId,
      sessionMode: "BRIDGE", esolLevel: "e2",
      turns: [], safeguardingFlagged: false, vocabIntroduced: [],
      session_source: "ai_tutor", duration_mins: 60,
      turn_scores: [], teaching_mode_sequence: [],
      start_time: new Date("2025-11-01T10:00:00Z"),
    });

  it("§I1 — §1 SOF invalid → row carries sof_code_invalid warning, SOF nulled", async () => {
    await seedConfig();
    const org = await createOrg();
    const learner = await createLearner(org._id, { sof_code: "999" });
    await seedSession(learner._id, org._id);

    const out = await buildIlrRows(org._id.toString(), ACADEMIC_YEAR);
    const row = out.rows[0];
    expect(row.SOF).toBeNull();
    expect(row._warnings).toContainEqual({
      type: "sof_code_invalid",
      code: "999",
    });
  });

  it("§I1.b — §1 SOF missing → sof_code_missing warning", async () => {
    await seedConfig();
    const org = await createOrg();
    const learner = await createLearner(org._id, { sof_code: null });
    await seedSession(learner._id, org._id);

    const out = await buildIlrRows(org._id.toString(), ACADEMIC_YEAR);
    expect(out.rows[0]._warnings).toContainEqual({
      type: "sof_code_missing",
    });
  });

  it("§I2 — §2 EnglishProgType: User value preferred over default", async () => {
    await seedConfig();
    const org = await createOrg();
    const learner = await createLearner(org._id, {
      english_prog_type: "27",
    });
    await seedSession(learner._id, org._id);

    const out = await buildIlrRows(org._id.toString(), ACADEMIC_YEAR);
    expect(out.rows[0].EnglishProgType).toBe("27");
    // No warning when the learner has an explicit value
    expect(
      out.rows[0]._warnings.some(
        (w) => w.type === "english_prog_type_defaulted",
      ),
    ).toBe(false);
  });

  it("§I2.b — §2 EnglishProgType: learner null → config default + warning", async () => {
    await seedConfig({ english_prog_type_default: "27" });
    const org = await createOrg();
    const learner = await createLearner(org._id, {
      english_prog_type: null,
    });
    await seedSession(learner._id, org._id);

    const out = await buildIlrRows(org._id.toString(), ACADEMIC_YEAR);
    expect(out.rows[0].EnglishProgType).toBe("27");
    expect(out.rows[0]._warnings).toContainEqual({
      type: "english_prog_type_defaulted",
      defaulted_to: "27",
    });
  });

  it("§I3 — §3 field_name_overrides is on the config; applied by the writer (not the row)", async () => {
    // The mapper produces canonical names; this test pins that the
    // CONFIG carries the override map for the serialiser to read.
    await seedConfig();
    const config = ComplianceConfigService.getConfig("ilr", ACADEMIC_YEAR);
    expect(
      (config?.rules as Record<string, unknown>).field_name_overrides,
    ).toEqual({ SOC2000: "SOC" });

    // And confirm a row through the pipeline keeps canonical names —
    // the writer (Function 13 To-Do 3) is what swaps them at emit time.
    const org = await createOrg();
    const learner = await createLearner(org._id);
    await seedSession(learner._id, org._id);
    const out = await buildIlrRows(org._id.toString(), ACADEMIC_YEAR);
    const keys = Object.keys(out.rows[0]);
    expect(keys).toContain("LearnAimRef");
    expect(keys).not.toContain("SOC2000");  // not on the row at all
    expect(keys).not.toContain("SOC");      // also not — applied at writer
  });

  it("§I4 — §4 LLDDT 15 with remap → row carries llddt_remapped, value remapped", async () => {
    await seedConfig();
    const org = await createOrg();
    const learner = await createLearner(org._id, { lldd_health_prob: 15 });
    await seedSession(learner._id, org._id);

    const out = await buildIlrRows(org._id.toString(), ACADEMIC_YEAR);
    const row = out.rows[0];
    expect(row.LLDDHealthProb).toBe(9);
    expect(row._warnings).toContainEqual({
      type: "llddt_remapped",
      from: "15",
      to: "9",
    });
    expect(row._skip_row).toBe(false);
  });

  it("§I4.b — §4 LLDDT 15 with NO remap → row marked _skip_row + llddt_blocked", async () => {
    // Same expired list, but no remap entry → handler blocks the row
    await seedConfig({
      expired_llddt_codes: ["15"],
      llddt_remapping: {}, // ← no remap target
    });
    const org = await createOrg();
    const learner = await createLearner(org._id, { lldd_health_prob: 15 });
    await seedSession(learner._id, org._id);

    const out = await buildIlrRows(org._id.toString(), ACADEMIC_YEAR);
    const row = out.rows[0];
    expect(row.LLDDHealthProb).toBeNull();
    expect(row._skip_row).toBe(true);
    expect(row._warnings).toContainEqual({
      type: "llddt_blocked",
      code: "15",
    });
  });

  it("§I5 — clean row carries no breaking-change warnings", async () => {
    // Everything aligned: SOF whitelisted, English_prog_type set, no
    // expired LLDDT.
    await seedConfig();
    const org = await createOrg();
    const learner = await createLearner(org._id, {
      sof_code: "105",
      english_prog_type: "25",
      lldd_health_prob: 9, // not expired
    });
    await seedSession(learner._id, org._id);

    const out = await buildIlrRows(org._id.toString(), ACADEMIC_YEAR);
    const row = out.rows[0];
    expect(row._warnings).toHaveLength(0);
    expect(row._skip_row).toBe(false);
  });
});
