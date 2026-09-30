/**
 * Silk bug brief section 2 — placement must never overwrite existing
 * Stage 3 objectives, and the "agreed" flag must belong to the
 * objectives the learner actually saw.
 */
import { Types } from "mongoose";
import Organisation from "../models/Organisation";
import User from "../models/User";
import AuditLog from "../models/AuditLog";
import { createStage3ObjectivesFromPlacement } from "../services/rarpa.service";
import { getMyGoals } from "../controllers/aiSession.controller";
import { loadPlacementBank } from "../services/placement.service";

const createOrg = () =>
  Organisation.create({
    name: "Guard Org",
    slug: `guard-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    contactEmail: "a@x.local",
    adminUserId: new Types.ObjectId(),
    billing_active: true,
    isActive: true,
  });

const createLearner = (
  orgId: unknown,
  overrides: Record<string, unknown> = {},
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
    esolLevel: "e3",
    l1Language: "turkish",
    ...overrides,
  });

const agreedObjectives = [
  {
    id: "obj-agreed-1",
    skill_domain: "Sc",
    description: "Hold a short conversation about work",
    set_at: new Date(),
    set_from: "placement_assessment",
    target_level: "e3",
  },
  {
    id: "obj-agreed-2",
    skill_domain: "general",
    description: "Develop functional English at Entry 3",
    set_at: new Date(),
    set_from: "placement_assessment",
    target_level: "e3",
  },
];

describe("placement never overwrites existing Stage 3 objectives", () => {
  it("keeps the learner's objectives on a re-run placement and records why", async () => {
    const org = await createOrg();
    const learner = await createLearner(org._id, {
      stage3_objectives: agreedObjectives,
    });

    const out = await createStage3ObjectivesFromPlacement(
      learner._id.toString(),
      "e1",
      ["Rt", "Wt"],
    );

    expect(out.map((o) => o.id)).toEqual(["obj-agreed-1", "obj-agreed-2"]);
    const fresh = await User.findById(learner._id).lean();
    expect((fresh?.stage3_objectives ?? []).map((o) => o.id)).toEqual([
      "obj-agreed-1",
      "obj-agreed-2",
    ]);
    const audit = await AuditLog.findOne({
      learner_id: learner._id,
      action: "placement_goals_preserved",
    }).lean();
    expect(audit).toBeTruthy();
    expect(
      (audit?.after_state as { placement_level?: string })?.placement_level,
    ).toBe("e1");
  });

  it("still creates objectives for a learner who has none", async () => {
    const org = await createOrg();
    const learner = await createLearner(org._id);
    const out = await createStage3ObjectivesFromPlacement(
      learner._id.toString(),
      "e2",
      ["Lr"],
    );
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((o) => o.set_from === "placement_assessment")).toBe(true);
  });

  it("replaces only when explicitly asked (teacher path)", async () => {
    const org = await createOrg();
    const learner = await createLearner(org._id, {
      stage3_objectives: agreedObjectives,
    });
    const out = await createStage3ObjectivesFromPlacement(
      learner._id.toString(),
      "e1",
      [],
      { replaceExisting: true },
    );
    expect(out.some((o) => o.id === "obj-agreed-1")).toBe(false);
  });
});

describe("agreed flag belongs to the objectives the learner saw", () => {
  const call = async (learnerId: string, orgId: string) => {
    const req = {
      user: { id: learnerId },
      esol_context: { org_id: orgId },
    };
    let payload: unknown = null;
    const res = {
      status: () => res,
      json: (body: unknown) => {
        payload = body;
        return res;
      },
    };
    await getMyGoals(
      req as never,
      res as never,
      ((e: unknown) => {
        throw e;
      }) as never,
    );
    return (payload as { data: { agreed_at: string | null } }).data;
  };

  it("reports agreed when the audit row covers the current objective ids", async () => {
    const org = await createOrg();
    const learner = await createLearner(org._id, {
      stage3_objectives: agreedObjectives,
    });
    await AuditLog.create({
      timestamp: new Date(),
      actor_type: "learner",
      actor_id: learner._id,
      org_id: org._id,
      learner_id: learner._id,
      action: "rarpa_stage3_negotiated",
      before_state: null,
      after_state: {
        agreed: true,
        objective_ids: ["obj-agreed-1", "obj-agreed-2"],
        source: "learner_confirmation",
      },
      reason: "test",
    });
    const data = await call(learner._id.toString(), org._id.toString());
    expect(data.agreed_at).not.toBeNull();
  });

  it("does not carry an old agreement over to objectives the learner never saw", async () => {
    const org = await createOrg();
    const learner = await createLearner(org._id, {
      stage3_objectives: [
        { ...agreedObjectives[0], id: "obj-new-1" },
        { ...agreedObjectives[1], id: "obj-new-2" },
      ],
    });
    await AuditLog.create({
      timestamp: new Date(),
      actor_type: "learner",
      actor_id: learner._id,
      org_id: org._id,
      learner_id: learner._id,
      action: "rarpa_stage3_negotiated",
      before_state: null,
      after_state: {
        agreed: true,
        objective_ids: ["obj-agreed-1", "obj-agreed-2"],
        source: "learner_confirmation",
      },
      reason: "test",
    });
    const data = await call(learner._id.toString(), org._id.toString());
    expect(data.agreed_at).toBeNull();
  });
});

describe("placement items carry Turkish", () => {
  it("every question and option has a non-empty Turkish string", () => {
    const bank = loadPlacementBank();
    for (const q of bank.questions) {
      expect(typeof q.question_tr).toBe("string");
      expect((q.question_tr ?? "").length).toBeGreaterThan(0);
      for (const o of q.options) {
        expect((o.text_tr ?? "").length).toBeGreaterThan(0);
      }
    }
  });
});
