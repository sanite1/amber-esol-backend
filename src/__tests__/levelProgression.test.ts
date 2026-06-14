/**
 * Tests for levelProgression.service — brief Function 11 To-Do 1.
 *
 *   H1   getDomainsFromCodes: maps codes → distinct domain count
 *   H2   getDomainsFromCodes: drops non-canonical codes silently
 *   H3   getDomainsFromCodes: handles empty / null input
 *
 *   L0   Returns not-ready when learner has no current esolLevel
 *   L1   All five criteria pass → ready_for_progression: true
 *   L2   C1 fails: only 2 distinct scenarios passed
 *   L3   C2 fails: average final_score below 0.75
 *   L4   C3 fails: only 2 domains covered
 *   L5   C4 fails: most recent session is ANCHOR-dominant
 *   L6   C5 fails: < 14 days since assignment
 *   L7   pre-platform sessions are excluded from the calculation
 *   L8   sessions whose scenario file is missing are excluded
 *   L9   level_assigned_at uses latest matching LevelChange over User.createdAt
 *  L10   Invalid / missing learner id → throws
 */

process.env.REFERRAL_JWT_SECRET =
  process.env.REFERRAL_JWT_SECRET ?? "test-secret";

// Queue mock — levelProgression.service.ts imports rarpaEvidenceQueue
// at module load (used by triggerStage5Review). The real queue calls
// createBullmqConnection() which throws unless REDIS_URL is set.
// checkLevelProgression itself never enqueues, but the module-level
// import has to resolve to load the SUT at all.
jest.mock("../queues", () => ({
  __esModule: true,
  rarpaEvidenceQueue: { add: jest.fn().mockResolvedValue({ id: "fake" }) },
}));

import { Types } from "mongoose";
import Organisation from "../models/Organisation";
import User from "../models/User";
import AISession from "../models/AISession";
import LevelChange from "../models/LevelChange";
import {
  checkLevelProgression,
  getDomainsFromCodes,
  __internals__,
} from "../services/levelProgression.service";

// ─────────────────────────────────────────────────────────────────────
// Fixture helpers
// ─────────────────────────────────────────────────────────────────────

const createOrg = async () =>
  Organisation.create({
    name: "LP Test Org",
    slug: `lp-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    contactEmail: "admin@lp.local",
    adminUserId: new Types.ObjectId(),
    billing_active: true,
    isActive: true,
  });

const createLearner = async (
  orgId: unknown,
  opts: { esolLevel?: string | null; createdAt?: Date } = {},
) => {
  const learner = await User.create({
    firstname: "LP",
    lastname: "Learner",
    email: `lp-${Date.now()}-${Math.random().toString(16).slice(2)}@lp.local`,
    password: "x",
    phoneNumber: "07000000000",
    role: "student",
    orgId,
    isActive: true,
    status: "active",
    verified: true,
    esolLevel: opts.esolLevel === undefined ? "e2" : opts.esolLevel,
    l1Language: "english",
  });
  if (opts.createdAt) {
    await User.collection.updateOne(
      { _id: learner._id as unknown as never },
      { $set: { createdAt: opts.createdAt } },
    );
  }
  return learner;
};

interface SeedSessionArgs {
  learnerId: unknown;
  orgId: unknown;
  scenarioId: string | null;
  finalScore: number | null;
  skillCodes?: string[];
  modeSequence?: string[];
  level?: string;
  source?: "ai_tutor" | "teacher_consolidation" | "pre_platform";
  completedAt?: Date;
}

const seedSession = async (args: SeedSessionArgs) => {
  const session = await AISession.create({
    learnerId: args.learnerId,
    orgId: args.orgId,
    sessionMode: "BRIDGE",
    esolLevel: args.level ?? "e2",
    nqf_level_at_start: args.level ?? "e2",
    turns: [],
    safeguardingFlagged: false,
    vocabIntroduced: [],
    session_source: args.source ?? "ai_tutor",
    scenario_id: args.scenarioId,
    final_score: args.finalScore,
    passed: args.finalScore !== null,
    skill_codes_covered: args.skillCodes ?? [],
    turn_scores: [],
    teaching_mode_sequence: args.modeSequence ?? [],
    start_time: new Date(),
    completedAt: args.completedAt ?? new Date(),
  });
  // Override completedAt via raw update so the sort order in tests is
  // deterministic (Mongoose's `default: Date.now` on the schema would
  // race with our intended ordering).
  if (args.completedAt) {
    await AISession.collection.updateOne(
      { _id: session._id as unknown as never },
      { $set: { completedAt: args.completedAt } },
    );
  }
  return session;
};

// Pass-threshold for s1/s2/s3 scenarios is 0.7 (verified in the JSON
// scenario files). Use this to keep test fixtures realistic.
const PASS = 0.85; // comfortably above 0.7
const FAIL = 0.5;

// ═════════════════════════════════════════════════════════════════════
// Helper tests
// ═════════════════════════════════════════════════════════════════════

describe("getDomainsFromCodes", () => {
  it("H1 — maps codes to distinct domains and counts them", () => {
    const { count, domains } = getDomainsFromCodes(["Sc", "Sd", "Lr", "Rt"]);
    expect(count).toBe(3);
    expect(domains.sort()).toEqual(["listening", "reading", "speaking"]);
  });

  it("H2 — drops non-canonical codes (Gemini drift)", () => {
    const { count, domains } = getDomainsFromCodes([
      "Sc",
      "speaking",
      "S1",
      "Lr",
    ]);
    expect(count).toBe(2);
    expect(new Set(domains)).toEqual(new Set(["speaking", "listening"]));
  });

  it("H3 — empty / null input is { 0, [] }", () => {
    expect(getDomainsFromCodes([])).toEqual({ count: 0, domains: [] });
    expect(getDomainsFromCodes(null)).toEqual({ count: 0, domains: [] });
    expect(getDomainsFromCodes(undefined)).toEqual({ count: 0, domains: [] });
  });
});

// ═════════════════════════════════════════════════════════════════════
// checkLevelProgression
// ═════════════════════════════════════════════════════════════════════

describe("checkLevelProgression", () => {
  it("L0 — learner with no esolLevel → not ready", async () => {
    const org = await createOrg();
    const learner = await createLearner(org._id, { esolLevel: null });
    const res = await checkLevelProgression(learner._id.toString());
    expect(res.ready_for_progression).toBe(false);
    expect(res.current_level).toBeNull();
  });

  it("L1 — all 5 criteria pass → ready_for_progression: true", async () => {
    const org = await createOrg();
    // Created 30 days ago so C5 passes
    const learner = await createLearner(org._id, {
      esolLevel: "e2",
      createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    });

    // 3 distinct scenarios passed, all comfortably above 0.75 average,
    // touching speaking + listening + reading + writing (4 domains).
    await seedSession({
      learnerId: learner._id,
      orgId: org._id,
      scenarioId: "s1_gp_appointment",
      finalScore: PASS,
      skillCodes: ["Sc", "Lr"],
      modeSequence: ["bridge", "bridge", "immersion"],
      completedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
    });
    await seedSession({
      learnerId: learner._id,
      orgId: org._id,
      scenarioId: "s2_payslip",
      finalScore: PASS,
      skillCodes: ["Rt", "Wt"],
      modeSequence: ["bridge", "bridge"],
      completedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
    });
    await seedSession({
      learnerId: learner._id,
      orgId: org._id,
      scenarioId: "s3_housing_rights",
      finalScore: PASS,
      skillCodes: ["Sc", "Lr"],
      modeSequence: ["bridge", "immersion"],
      completedAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000),
    });

    const res = await checkLevelProgression(learner._id.toString());
    expect(res.ready_for_progression).toBe(true);
    expect(res.criteria_met.scenario_completion.passed).toBe(true);
    expect(res.criteria_met.scenario_completion.distinct_scenarios_passed).toBe(
      3,
    );
    expect(res.criteria_met.score_threshold.passed).toBe(true);
    expect(res.criteria_met.score_threshold.average_score).toBeCloseTo(PASS, 5);
    expect(res.criteria_met.skill_domain_coverage.passed).toBe(true);
    expect(res.criteria_met.skill_domain_coverage.domains_covered).toBe(4);
    expect(res.criteria_met.no_anchor_dominance.passed).toBe(true);
    expect(res.criteria_met.minimum_time.passed).toBe(true);
    expect(res.current_level).toBe("e2");
  });

  it("L2 — only 2 distinct scenarios passed → C1 fails", async () => {
    const org = await createOrg();
    const learner = await createLearner(org._id, {
      createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    });

    // Two distinct scenarios, three passes (one scenario twice)
    await seedSession({
      learnerId: learner._id,
      orgId: org._id,
      scenarioId: "s1_gp_appointment",
      finalScore: PASS,
      skillCodes: ["Sc", "Lr", "Rt"],
    });
    await seedSession({
      learnerId: learner._id,
      orgId: org._id,
      scenarioId: "s1_gp_appointment",
      finalScore: PASS,
      skillCodes: ["Sc", "Lr"],
    });
    await seedSession({
      learnerId: learner._id,
      orgId: org._id,
      scenarioId: "s2_payslip",
      finalScore: PASS,
      skillCodes: ["Rt", "Wt"],
    });

    const res = await checkLevelProgression(learner._id.toString());
    expect(res.ready_for_progression).toBe(false);
    expect(res.criteria_met.scenario_completion.passed).toBe(false);
    expect(res.criteria_met.scenario_completion.distinct_scenarios_passed).toBe(
      2,
    );
  });

  it("L3 — passing scores below 0.75 average → C2 fails", async () => {
    const org = await createOrg();
    const learner = await createLearner(org._id, {
      createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    });

    // All three above pass_threshold (0.7) but average is 0.72 — below 0.75
    await seedSession({
      learnerId: learner._id,
      orgId: org._id,
      scenarioId: "s1_gp_appointment",
      finalScore: 0.71,
      skillCodes: ["Sc", "Lr", "Rt", "Wt"],
    });
    await seedSession({
      learnerId: learner._id,
      orgId: org._id,
      scenarioId: "s2_payslip",
      finalScore: 0.72,
      skillCodes: ["Rt", "Wt"],
    });
    await seedSession({
      learnerId: learner._id,
      orgId: org._id,
      scenarioId: "s3_housing_rights",
      finalScore: 0.73,
      skillCodes: ["Sc", "Lr"],
    });

    const res = await checkLevelProgression(learner._id.toString());
    expect(res.ready_for_progression).toBe(false);
    expect(res.criteria_met.score_threshold.passed).toBe(false);
    expect(res.criteria_met.score_threshold.average_score).toBeCloseTo(0.72, 2);
  });

  it("L4 — only 2 domains covered → C3 fails", async () => {
    const org = await createOrg();
    const learner = await createLearner(org._id, {
      createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    });

    await seedSession({
      learnerId: learner._id,
      orgId: org._id,
      scenarioId: "s1_gp_appointment",
      finalScore: PASS,
      skillCodes: ["Sc"], // speaking only
    });
    await seedSession({
      learnerId: learner._id,
      orgId: org._id,
      scenarioId: "s2_payslip",
      finalScore: PASS,
      skillCodes: ["Lr"], // listening only
    });
    await seedSession({
      learnerId: learner._id,
      orgId: org._id,
      scenarioId: "s3_housing_rights",
      finalScore: PASS,
      skillCodes: ["Sc", "Lr"], // same two
    });

    const res = await checkLevelProgression(learner._id.toString());
    expect(res.ready_for_progression).toBe(false);
    expect(res.criteria_met.skill_domain_coverage.passed).toBe(false);
    expect(res.criteria_met.skill_domain_coverage.domains_covered).toBe(2);
  });

  it("L5 — most recent session is ANCHOR-dominant → C4 fails", async () => {
    const org = await createOrg();
    const learner = await createLearner(org._id, {
      createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    });

    // 3 earlier sessions are clean (bridge-only), but the most recent
    // is 4/5 anchor = 80%. That single recent session fails C4.
    await seedSession({
      learnerId: learner._id,
      orgId: org._id,
      scenarioId: "s1_gp_appointment",
      finalScore: PASS,
      skillCodes: ["Sc", "Lr"],
      modeSequence: ["bridge", "bridge"],
      completedAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
    });
    await seedSession({
      learnerId: learner._id,
      orgId: org._id,
      scenarioId: "s2_payslip",
      finalScore: PASS,
      skillCodes: ["Rt", "Wt"],
      modeSequence: ["bridge", "bridge"],
      completedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
    });
    await seedSession({
      learnerId: learner._id,
      orgId: org._id,
      scenarioId: "s3_housing_rights",
      finalScore: PASS,
      skillCodes: ["Sc", "Lr"],
      modeSequence: ["anchor", "anchor", "anchor", "anchor", "bridge"],
      completedAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000),
    });

    const res = await checkLevelProgression(learner._id.toString());
    expect(res.ready_for_progression).toBe(false);
    expect(res.criteria_met.no_anchor_dominance.passed).toBe(false);
    expect(
      res.criteria_met.no_anchor_dominance.recent_session_anchor_ratios[0],
    ).toBeCloseTo(0.8, 5);
  });

  it("L6 — < 14 days since level assignment → C5 fails", async () => {
    const org = await createOrg();
    // Learner enrolled only 5 days ago, no LevelChange row.
    const learner = await createLearner(org._id, {
      createdAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
    });

    await seedSession({
      learnerId: learner._id,
      orgId: org._id,
      scenarioId: "s1_gp_appointment",
      finalScore: PASS,
      skillCodes: ["Sc", "Lr"],
    });
    await seedSession({
      learnerId: learner._id,
      orgId: org._id,
      scenarioId: "s2_payslip",
      finalScore: PASS,
      skillCodes: ["Rt", "Wt"],
    });
    await seedSession({
      learnerId: learner._id,
      orgId: org._id,
      scenarioId: "s3_housing_rights",
      finalScore: PASS,
      skillCodes: ["Sc", "Lr"],
    });

    const res = await checkLevelProgression(learner._id.toString());
    expect(res.ready_for_progression).toBe(false);
    expect(res.criteria_met.minimum_time.passed).toBe(false);
    expect(res.criteria_met.minimum_time.days_at_level).toBe(5);
  });

  it("L7 — pre-platform sessions are excluded", async () => {
    const org = await createOrg();
    const learner = await createLearner(org._id, {
      createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    });

    // 3 pre-platform sessions with great scores — should NOT count
    await seedSession({
      learnerId: learner._id,
      orgId: org._id,
      scenarioId: "s1_gp_appointment",
      finalScore: PASS,
      skillCodes: ["Sc", "Lr", "Rt", "Wt"],
      source: "pre_platform",
    });
    await seedSession({
      learnerId: learner._id,
      orgId: org._id,
      scenarioId: "s2_payslip",
      finalScore: PASS,
      skillCodes: ["Rt", "Wt"],
      source: "pre_platform",
    });
    await seedSession({
      learnerId: learner._id,
      orgId: org._id,
      scenarioId: "s3_housing_rights",
      finalScore: PASS,
      skillCodes: ["Sc", "Lr"],
      source: "pre_platform",
    });

    const res = await checkLevelProgression(learner._id.toString());
    expect(res.ready_for_progression).toBe(false);
    expect(res.criteria_met.scenario_completion.distinct_scenarios_passed).toBe(
      0,
    );
  });

  it("L8 — sessions whose scenario file is missing are excluded", async () => {
    const org = await createOrg();
    const learner = await createLearner(org._id, {
      createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    });

    await seedSession({
      learnerId: learner._id,
      orgId: org._id,
      scenarioId: "s1_gp_appointment",
      finalScore: PASS,
      skillCodes: ["Sc", "Lr"],
    });
    await seedSession({
      learnerId: learner._id,
      orgId: org._id,
      scenarioId: "s2_payslip",
      finalScore: PASS,
      skillCodes: ["Rt", "Wt"],
    });
    // Bogus scenario id — file doesn't exist
    await seedSession({
      learnerId: learner._id,
      orgId: org._id,
      scenarioId: "s99_does_not_exist",
      finalScore: PASS,
      skillCodes: ["Sc", "Lr"],
    });

    const res = await checkLevelProgression(learner._id.toString());
    expect(res.criteria_met.scenario_completion.distinct_scenarios_passed).toBe(
      2,
    );
    expect(res.criteria_met.scenario_completion.scenario_ids).not.toContain(
      "s99_does_not_exist",
    );
  });

  it("L9 — level_assigned_at prefers latest matching LevelChange over User.createdAt", async () => {
    const org = await createOrg();
    // User created 60 days ago, but LevelChange to e2 only 8 days ago
    // → days_at_level should be 8, criterion 5 fails despite long enrolment.
    const learner = await createLearner(org._id, {
      createdAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000),
    });
    await LevelChange.create({
      learnerId: learner._id,
      orgId: org._id,
      fromLevel: "e1",
      toLevel: "e2",
      changedBy: new Types.ObjectId(),
      reason: "promotion",
      effectiveDate: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
    });

    const res = await checkLevelProgression(learner._id.toString());
    expect(res.criteria_met.minimum_time.days_at_level).toBe(8);
    expect(res.criteria_met.minimum_time.passed).toBe(false);
  });

  it("L10 — invalid / missing learner id → throws", async () => {
    await expect(checkLevelProgression("not-an-objectid")).rejects.toThrow();
    await expect(checkLevelProgression("")).rejects.toThrow();
    await expect(
      checkLevelProgression(new Types.ObjectId().toString()),
    ).rejects.toThrow(/not found/i);
  });
});

// ═════════════════════════════════════════════════════════════════════
// Internal — evaluateAnchorDominance edge cases
// ═════════════════════════════════════════════════════════════════════

describe("evaluateAnchorDominance (internal)", () => {
  it("empty sequences are treated as ratio 0 (vacuously pass)", () => {
    const r = __internals__.evaluateAnchorDominance([[], []]);
    expect(r.passed).toBe(true);
    expect(r.ratios).toEqual([0, 0]);
  });

  it("exactly 50% anchor is NOT dominant (strictly greater triggers fail)", () => {
    const r = __internals__.evaluateAnchorDominance([
      ["anchor", "bridge"],
      ["anchor", "bridge"],
    ]);
    expect(r.passed).toBe(true);
    expect(r.ratios).toEqual([0.5, 0.5]);
  });

  it("only the 2 most recent sessions are considered", () => {
    // 3 sessions; the oldest is anchor-dominant but should be ignored.
    const r = __internals__.evaluateAnchorDominance([
      ["bridge", "bridge"],
      ["bridge", "bridge"],
      ["anchor", "anchor", "anchor", "anchor"],
    ]);
    expect(r.passed).toBe(true);
    expect(r.ratios).toHaveLength(2);
  });
});
