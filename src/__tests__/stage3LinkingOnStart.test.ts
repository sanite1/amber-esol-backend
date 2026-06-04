/**
 * Stage 3 objective linking at session start — brief Function 8 To-Do 3.
 *
 * Five cases:
 *   1. Happy path — learner's matching objectives are linked
 *   2. "general" objective always matches, regardless of scenario domains
 *   3. Zero-match path — session proceeds, warning logged
 *   4. Learner with no objectives — empty array, no crash
 *   5. The order of scenario domains doesn't affect matching
 */

jest.mock("../queues", () => ({
  __esModule: true,
  esolSessionQueue:   { add: jest.fn().mockResolvedValue(undefined) },
  notificationsQueue: { add: jest.fn().mockResolvedValue(undefined) },
  priorityQueueQueue: { add: jest.fn().mockResolvedValue(undefined) },
}));

jest.mock("../services/ComplianceConfigService", () => ({
  __esModule: true,
  default: { getCurrent: jest.fn().mockReturnValue({ version: 1 }) },
}));

process.env.REFERRAL_JWT_SECRET = process.env.REFERRAL_JWT_SECRET ?? "test-secret";

import { Types } from "mongoose";
import { randomUUID } from "crypto";
import Organisation from "../models/Organisation";
import User from "../models/User";
import AISession from "../models/AISession";
import { startSessionService } from "../services/aiSession.service";
import logger from "../config/logger";

// ─────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────

const createOrg = async () =>
  Organisation.create({
    name: "Stage3 Test Org",
    slug: `s3-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    contactEmail: "a@x.local",
    adminUserId: new Types.ObjectId(),
    billing_active: true,
    isActive: true,
  });

const createLearner = async (
  orgId: unknown,
  objectives: Array<{ skill_domain: string; description?: string }>,
  overrides: Record<string, unknown> = {}
) =>
  User.create({
    firstname: "Test",
    lastname: "Learner",
    email: `l-${Date.now()}-${Math.random().toString(16).slice(2)}@x.local`,
    password: "x",
    phoneNumber: "07000000000",
    role: "student",
    orgId,
    isActive: true,
    status: "active",
    verified: true,
    esolLevel: "e2",
    l1Language: "english",
    esol_aim_type: "regulated",
    stage3_objectives: objectives.map((o) => ({
      id: randomUUID(),
      skill_domain: o.skill_domain,
      description: o.description ?? `Stage 3 objective for ${o.skill_domain}`,
      set_at: new Date(),
      set_from: "placement_assessment",
      target_level: "e2",
    })),
    ...overrides,
  });

const startInOrg = (learnerId: string, orgId: string, scenarioId = "s1_gp_appointment") =>
  startSessionService({
    scenarioId,
    learnerId,
    orgId,
  });

// ─────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────

describe("Stage 3 objective linking at session start", () => {
  it("links the learner's matching anchor-code objectives to the session", async () => {
    const org = await createOrg();
    // s1_gp_appointment covers ["Sc", "Lr", "Rt"]
    const learner = await createLearner(org._id, [
      { skill_domain: "Sc" },    // ← in scenario
      { skill_domain: "Lr" },    // ← in scenario
      { skill_domain: "Wt" },    // not in scenario — should be dropped
      { skill_domain: "general" }, // always matches
    ]);

    const res = await startInOrg(
      learner._id.toString(),
      org._id.toString(),
      "s1_gp_appointment"
    );
    const sessionId = (res.data as { session_id: string }).session_id;

    const session = await AISession.findById(sessionId).lean();
    const linkedIds = session?.stage3_objective_ids ?? [];

    // 3 of the 4 learner objectives match (Sc, Lr, general)
    expect(linkedIds).toHaveLength(3);

    // The Wt objective's id is NOT in the link set
    const learnerDoc = await User.findById(learner._id).lean();
    const wtObjective = (learnerDoc as any).stage3_objectives.find(
      (o: { skill_domain: string }) => o.skill_domain === "Wt"
    );
    expect(linkedIds).not.toContain(wtObjective.id);
  });

  it('"general" objective always matches, regardless of scenario domains', async () => {
    const org = await createOrg();
    // s1_gp_appointment covers ["Sc", "Lr", "Rt"] — learner has only a Wt
    // objective + the always-matches "general" one.
    const learner = await createLearner(org._id, [
      { skill_domain: "Wt" },        // doesn't match s1
      { skill_domain: "general" },   // always matches
    ]);

    const res = await startInOrg(
      learner._id.toString(),
      org._id.toString(),
      "s1_gp_appointment"
    );
    const sessionId = (res.data as { session_id: string }).session_id;

    const session = await AISession.findById(sessionId).lean();
    const linkedIds = session?.stage3_objective_ids ?? [];

    // Only the "general" objective matches
    expect(linkedIds).toHaveLength(1);
    const learnerDoc = await User.findById(learner._id).lean();
    const generalObj = (learnerDoc as any).stage3_objectives.find(
      (o: { skill_domain: string }) => o.skill_domain === "general"
    );
    expect(linkedIds[0]).toBe(generalObj.id);
  });

  it("logs a warning and proceeds when zero objectives match", async () => {
    const org = await createOrg();
    // s1_gp_appointment covers ["Sc", "Lr", "Rt"] — learner has ONLY a
    // Wt objective + no "general". Zero matches.
    const learner = await createLearner(org._id, [{ skill_domain: "Wt" }]);

    const warnSpy = jest.spyOn(logger, "warn");
    try {
      const res = await startInOrg(
        learner._id.toString(),
        org._id.toString(),
        "s1_gp_appointment"
      );
      const sessionId = (res.data as { session_id: string }).session_id;
      const session = await AISession.findById(sessionId).lean();

      // Session was created despite zero objective links
      expect(session).toBeTruthy();
      expect(session?.stage3_objective_ids).toEqual([]);

      // Warning logged with greppable text
      const called = warnSpy.mock.calls.find((c) => {
        const msg = c[c.length - 1];
        return typeof msg === "string" && /Stage 3 link empty/i.test(msg);
      });
      expect(called).toBeDefined();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("learner with zero objectives does not crash", async () => {
    const org = await createOrg();
    const learner = await createLearner(org._id, []);  // no objectives at all

    const res = await startInOrg(
      learner._id.toString(),
      org._id.toString(),
      "s1_gp_appointment"
    );
    const sessionId = (res.data as { session_id: string }).session_id;
    const session = await AISession.findById(sessionId).lean();

    expect(session?.stage3_objective_ids).toEqual([]);
  });

  it("matching is order-independent on the scenario side", async () => {
    // s3_housing_rights covers ["Rt", "Sc", "Lr"]
    // s2_payslip covers ["Rt", "Sc"]
    // Same learner against both — Lr should appear only in s3's link set.
    const org = await createOrg();
    const learner = await createLearner(org._id, [
      { skill_domain: "Rt" },
      { skill_domain: "Sc" },
      { skill_domain: "Lr" },
    ]);

    // s3 — 3 matches (Rt, Sc, Lr)
    const r3 = await startInOrg(
      learner._id.toString(),
      org._id.toString(),
      "s3_housing_rights"
    );
    const s3session = await AISession.findById(
      (r3.data as { session_id: string }).session_id
    ).lean();
    expect(s3session?.stage3_objective_ids).toHaveLength(3);

    // s2 — 2 matches (Rt, Sc) — Lr objective is dropped
    // Use a different start minute to bust the start-of-session
    // idempotency window so a new session is created.
    await new Promise((r) => setTimeout(r, 100));
    // Force a different idempotency key by minting a new scenario id
    // (s2 vs s3) — already different, so the wrap doesn't collide.
    const r2 = await startInOrg(
      learner._id.toString(),
      org._id.toString(),
      "s2_payslip"
    );
    const s2session = await AISession.findById(
      (r2.data as { session_id: string }).session_id
    ).lean();
    expect(s2session?.stage3_objective_ids).toHaveLength(2);
  });
});
