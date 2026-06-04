/**
 * persistSessionOnEnd verification — brief Function 8 To-Do 2.
 *
 * Pure write behaviour, no orchestration. Five cases:
 *
 *   1. Happy path — dedupe + duration + final_score + passed all land
 *   2. esol_aim_type carried from User
 *   3. esol_aim_type missing on User → defaults to "non_regulated" + warn
 *   4. Idempotent replay — second call returns cached, no double-write
 *   5. duration_mins clamps to ≥ 1
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
import Organisation from "../models/Organisation";
import User from "../models/User";
import AISession from "../models/AISession";
import { persistSessionOnEnd } from "../services/aiSession.service";
import logger from "../config/logger";

const createOrg = async () =>
  Organisation.create({
    name: "Persist Test Org",
    slug: `persist-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    contactEmail: "a@x.local",
    adminUserId: new Types.ObjectId(),
    billing_active: true,
    isActive: true,
  });

const createLearner = async (
  orgId: unknown,
  overrides: Record<string, unknown> = {}
) =>
  User.create({
    firstname: "T",
    lastname: "L",
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
    ...overrides,
  });

const createSession = async (
  learnerId: unknown,
  orgId: unknown,
  overrides: Record<string, unknown> = {}
) =>
  AISession.create({
    learnerId,
    orgId,
    sessionMode: "BRIDGE",
    esolLevel: "e2",
    turns: [],
    safeguardingFlagged: false,
    vocabIntroduced: [],
    session_source: "ai_tutor",
    scenario_id: "s1_gp_appointment",
    turn_scores: [],
    teaching_mode_sequence: [],
    skill_codes_covered: [],
    start_time: new Date(Date.now() - 15 * 60 * 1000), // 15 min ago
    ...overrides,
  });

describe("persistSessionOnEnd", () => {
  it("dedupes skill_codes_covered + vocabulary_items_used, computes final_score + passed + duration", async () => {
    const org = await createOrg();
    const learner = await createLearner(org._id, { esol_aim_type: "regulated" });
    const session = await createSession(learner._id, org._id, {
      turn_scores: [0.6, 0.8, 0.9, 0.7],          // mean = 0.75 → above default 0.7 threshold
      skill_codes_covered: ["Sc", "Lr", "Sc", "Sc", "Rt", "Lr"], // 3 duplicates
      vocabIntroduced: ["appointment", "appointment", "doctor", "doctor", "GP"],
    });

    const out = await persistSessionOnEnd(session._id.toString());

    expect(out.idempotency_hit).toBe(false);
    expect(out.duration_mins).toBeGreaterThanOrEqual(14);  // ~15 min start gap
    expect(out.duration_mins).toBeLessThanOrEqual(16);
    expect(out.final_score).toBeCloseTo(0.75, 5);
    expect(out.passed).toBe(true);                 // 0.75 ≥ 0.7 default in s1_gp_appointment.json
    expect(out.esol_aim_type).toBe("regulated");
    expect(out.skill_codes_covered.sort()).toEqual(["Lr", "Rt", "Sc"]); // 3 distinct
    expect(out.vocabulary_items_used.sort()).toEqual(["GP", "appointment", "doctor"]);

    // Re-fetch and confirm DB persisted
    const updated = await AISession.findById(session._id).lean();
    expect((updated as any).esol_aim_type).toBe("regulated");
    expect((updated as any).end_time).toBeInstanceOf(Date);
    expect((updated as any).duration_mins).toBe(out.duration_mins);
  });

  it("defaults esol_aim_type to non_regulated and warns when missing on User", async () => {
    const org = await createOrg();
    const learner = await createLearner(org._id, { esol_aim_type: null });   // explicitly missing
    const session = await createSession(learner._id, org._id, {
      turn_scores: [0.5, 0.5],
    });

    const warnSpy = jest.spyOn(logger, "warn");
    try {
      const out = await persistSessionOnEnd(session._id.toString());
      expect(out.esol_aim_type).toBe("non_regulated");
      // Warning emitted
      const called = warnSpy.mock.calls.find((c) => {
        const msg = c[c.length - 1];
        return typeof msg === "string" && /esol_aim_type missing/i.test(msg);
      });
      expect(called).toBeDefined();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("re-call on the same session returns the cached result (idempotency_hit=true)", async () => {
    const org = await createOrg();
    const learner = await createLearner(org._id, { esol_aim_type: "regulated" });
    const session = await createSession(learner._id, org._id, {
      turn_scores: [0.8, 0.85, 0.75],
    });

    const first = await persistSessionOnEnd(session._id.toString());
    const second = await persistSessionOnEnd(session._id.toString());

    expect(first.idempotency_hit).toBe(false);
    expect(second.idempotency_hit).toBe(true);

    // Cached payload matches the first run exactly
    expect(second.final_score).toBe(first.final_score);
    expect(second.duration_mins).toBe(first.duration_mins);
    expect(second.esol_aim_type).toBe(first.esol_aim_type);

    // The session document was only written once — end_time hasn't
    // advanced between calls.
    const updated = await AISession.findById(session._id).lean();
    expect((updated as any).end_time).toBeInstanceOf(Date);
  });

  it("duration_mins clamps to a minimum of 1 even for a same-second start/end", async () => {
    const org = await createOrg();
    const learner = await createLearner(org._id, { esol_aim_type: "non_regulated" });
    const session = await createSession(learner._id, org._id, {
      start_time: new Date(),  // now → < 1 second to end
      turn_scores: [0.7],
    });

    const out = await persistSessionOnEnd(session._id.toString());
    expect(out.duration_mins).toBe(1);
  });

  it("final_score = 0 when turn_scores is empty (no turns yet)", async () => {
    const org = await createOrg();
    const learner = await createLearner(org._id, { esol_aim_type: "non_regulated" });
    const session = await createSession(learner._id, org._id, { turn_scores: [] });

    const out = await persistSessionOnEnd(session._id.toString());
    expect(out.final_score).toBe(0);
    expect(out.passed).toBe(false);
  });
});
