/**
 * Tests for the admin level-change confirm/reject services —
 * brief Function 11 To-Do 2.
 *
 *   C1   confirm happy path: LevelChange row + User.esolLevel flipped +
 *        Stage 3 objectives appended + Stage 5 stub + learner email
 *        enqueued + AuditLog "level_change_confirmed"
 *   C2   adjacency rule: e1 → e3 rejected with 400
 *   C3   demotion / same-level rejected with 400
 *   C4   readiness re-check failure → 409 (no level change)
 *   C5   non-student target → 403
 *   C6   learner with no org → 400
 *   C7   bad new_level (typo / unknown) → 400
 *   C8   level-change resets progression_notification_sent_at + _level
 *        so the dedup window doesn't suppress a fresh ready flag at
 *        the new level
 *   C9   learner with CSV-placeholder email → no email enqueued
 *
 *   R1   reject happy path: AuditLog "level_change_rejected" + org admin
 *        in-app notification + email; learner state UNCHANGED
 *   R2   reject with empty reason → 400
 *   R3   reject for non-existent learner → 404
 *
 *   A1   LEVEL_LADDER + isAdjacentLevelUp pure helpers
 */

process.env.REFERRAL_JWT_SECRET =
  process.env.REFERRAL_JWT_SECRET ?? "test-secret";

// Queues + notification helper mocked so we can inspect dispatch
const notificationsAdd = jest.fn().mockResolvedValue({ id: "fake" });
jest.mock("../queues", () => ({
  __esModule: true,
  notificationsQueue: { add: notificationsAdd },
  priorityQueueQueue: { add: jest.fn().mockResolvedValue({ id: "fake" }) },
  esolSessionQueue: { add: jest.fn().mockResolvedValue({ id: "fake" }) },
}));

const createNotificationMock = jest.fn().mockResolvedValue(undefined);
jest.mock("../services/notification.service", () => ({
  __esModule: true,
  createNotification: createNotificationMock,
}));

// checkLevelProgression mocked so each test can pick ready/not-ready.
// triggerStage5Review is stubbed (returns a fake id) — the dedicated
// triggerStage5Review.test.ts suite covers its behaviour; here we only
// care that confirmLevelChangeService delegates to it.
const checkLevelProgressionMock = jest.fn();
const triggerStage5ReviewMock = jest.fn().mockResolvedValue({
  stage5_review_id: "000000000000000000000000",
  notification_language_used: "english",
});
jest.mock("../services/levelProgression.service", () => ({
  __esModule: true,
  checkLevelProgression: checkLevelProgressionMock,
  triggerStage5Review: triggerStage5ReviewMock,
}));

import { Types } from "mongoose";
import Organisation from "../models/Organisation";
import User from "../models/User";
import LevelChange from "../models/LevelChange";
import AuditLog from "../models/AuditLog";
import {
  confirmLevelChangeService,
  rejectLevelChangeService,
  isAdjacentLevelUp,
  LEVEL_LADDER,
} from "../services/adminLevelChange.service";

// ─────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────

const createOrg = async (name = "LC Org") => {
  const adminId = new Types.ObjectId();
  await User.create({
    _id: adminId,
    firstname: "Org",
    lastname: "Admin",
    email: `admin-${Date.now()}-${Math.random().toString(16).slice(2)}@lc.local`,
    password: "x",
    phoneNumber: "07000000000",
    role: "org_admin",
    isActive: true,
    status: "active",
    verified: true,
  });
  const org = await Organisation.create({
    name,
    slug: `lc-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    contactEmail: "admin@lc.local",
    adminUserId: adminId,
    billing_active: true,
    isActive: true,
  });
  return { org, adminId };
};

const createAdmin = async () =>
  User.create({
    firstname: "Amber",
    lastname: "Admin",
    email: `amber-${Date.now()}-${Math.random().toString(16).slice(2)}@amber.local`,
    password: "x",
    phoneNumber: "07000000001",
    role: "admin",
    isActive: true,
    status: "active",
    verified: true,
  });

interface LearnerOpts {
  esolLevel?: string;
  orgId?: unknown;
  email?: string;
  flags?: string[];
  notifSentAt?: Date;
  notifLevel?: string;
  l1?: string;
}
const createLearner = async (opts: LearnerOpts = {}) => {
  return User.create({
    firstname: "LC",
    lastname: "Learner",
    email:
      opts.email ??
      `learner-${Date.now()}-${Math.random().toString(16).slice(2)}@lc.local`,
    password: "x",
    phoneNumber: "07000000002",
    role: "student",
    orgId: opts.orgId,
    isActive: true,
    status: "active",
    verified: true,
    esolLevel: opts.esolLevel ?? "e2",
    l1Language: opts.l1 ?? "arabic",
    skillWeaknessFlags: opts.flags ?? ["Sc", "Lr"],
    progression_notification_sent_at: opts.notifSentAt ?? null,
    progression_notification_level: opts.notifLevel ?? null,
  });
};

const readyResult = (currentLevel: string) => ({
  learner_id: "stub",
  current_level: currentLevel,
  ready_for_progression: true,
  criteria_met: {
    scenario_completion: {
      passed: true,
      distinct_scenarios_passed: 3,
      required: 3,
      scenario_ids: ["s1", "s2", "s3"],
    },
    score_threshold: {
      passed: true,
      average_score: 0.85,
      required: 0.75,
      sample_size: 3,
    },
    skill_domain_coverage: {
      passed: true,
      domains_covered: 4,
      required: 3,
      domains: [],
    },
    no_anchor_dominance: {
      passed: true,
      recent_session_anchor_ratios: [0, 0],
      threshold_ratio: 0.5,
    },
    minimum_time: {
      passed: true,
      days_at_level: 21,
      required: 14,
      level_assigned_at: new Date().toISOString(),
    },
  },
  checked_at: new Date().toISOString(),
});

const notReadyResult = (currentLevel: string) => ({
  ...readyResult(currentLevel),
  ready_for_progression: false,
  criteria_met: {
    ...readyResult(currentLevel).criteria_met,
    minimum_time: {
      passed: false,
      days_at_level: 3,
      required: 14,
      level_assigned_at: new Date().toISOString(),
    },
  },
});

beforeEach(() => {
  notificationsAdd.mockClear();
  createNotificationMock.mockClear();
  checkLevelProgressionMock.mockReset();
  triggerStage5ReviewMock.mockClear();
});

// ═════════════════════════════════════════════════════════════════════
// A1 — Pure helpers
// ═════════════════════════════════════════════════════════════════════

describe("LEVEL_LADDER + isAdjacentLevelUp", () => {
  it("A1 — ladder order is e1→e2→e3→l1→l2; only adjacent up returns true", () => {
    expect(LEVEL_LADDER).toEqual(["e1", "e2", "e3", "l1", "l2"]);
    expect(isAdjacentLevelUp("e1", "e2")).toBe(true);
    expect(isAdjacentLevelUp("e2", "e3")).toBe(true);
    expect(isAdjacentLevelUp("e3", "l1")).toBe(true);
    expect(isAdjacentLevelUp("l1", "l2")).toBe(true);
    // No skipping
    expect(isAdjacentLevelUp("e1", "e3")).toBe(false);
    expect(isAdjacentLevelUp("e2", "l1")).toBe(false);
    // No demotion
    expect(isAdjacentLevelUp("e2", "e1")).toBe(false);
    // No no-op
    expect(isAdjacentLevelUp("e2", "e2")).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════
// C1–C9 — confirm
// ═════════════════════════════════════════════════════════════════════

describe("confirmLevelChangeService", () => {
  it("C1 — happy path: LevelChange + User.esolLevel + Stage 3 + Stage 5 + email + audit", async () => {
    const { org } = await createOrg("Newcastle FE");
    const admin = await createAdmin();
    const learner = await createLearner({
      orgId: org._id,
      esolLevel: "e2",
      flags: ["Sc", "Wt"],
      l1: "arabic",
    });
    checkLevelProgressionMock.mockResolvedValueOnce(readyResult("e2"));

    const res = await confirmLevelChangeService(
      { learner_id: learner._id.toString(), new_level: "e3" },
      admin._id.toString(),
    );
    const data = res.data as {
      learner_id: string;
      old_level: string;
      new_level: string;
      level_change_id: string;
    };

    expect(data.old_level).toBe("e2");
    expect(data.new_level).toBe("e3");
    expect(Types.ObjectId.isValid(data.level_change_id)).toBe(true);

    // LevelChange row written with the right fields
    const lc = await LevelChange.findById(data.level_change_id).lean();
    expect(lc?.fromLevel).toBe("e2");
    expect(lc?.toLevel).toBe("e3");
    expect(lc?.changedBy?.toString()).toBe(admin._id.toString());
    expect(lc?.triggerEvent).toBe("progression_criteria_met");
    expect(lc?.reason).toBe("Amber admin confirmed progression");

    // User esolLevel flipped + Stage 3 appended
    const updated = await User.findById(learner._id).lean();
    expect(updated?.esolLevel).toBe("e3");
    const objectives = updated?.stage3_objectives ?? [];
    expect(objectives.length).toBeGreaterThan(0);
    // All fresh objectives are tagged level_change
    const fresh = objectives.filter((o) => o.set_from === "level_change");
    expect(fresh.length).toBeGreaterThan(0);
    // All fresh objectives target the new level
    for (const o of fresh) expect(o.target_level).toBe("e3");

    // Stage 5 stub delegated to triggerStage5Review — the dedicated
    // suite (triggerStage5Review.test.ts) covers row creation +
    // localised notification. Here we just verify the call site
    // delegates with the right (old_level, new_level) ordering.
    expect(triggerStage5ReviewMock).toHaveBeenCalledTimes(1);
    expect(triggerStage5ReviewMock).toHaveBeenCalledWith(
      learner._id.toString(),
      "e2",
      "e3",
    );

    // In-app notification to learner
    expect(createNotificationMock).toHaveBeenCalledTimes(1);
    expect(createNotificationMock.mock.calls[0][0].type).toBe(
      "progression_confirmed",
    );

    // Celebration email enqueued
    const email = notificationsAdd.mock.calls.find(
      (c) => c[0] === "progression-confirmed-email",
    );
    expect(email).toBeDefined();
    expect(email![1].payload.l1_language).toBe("arabic");
    expect(email![1].payload.new_level).toBe("e3");

    // AuditLog row
    const audit = await AuditLog.findOne({
      learner_id: learner._id,
      action: "level_change_confirmed",
    }).lean();
    expect(audit).toBeTruthy();
    expect((audit?.before_state as { esol_level?: string })?.esol_level).toBe(
      "e2",
    );
    expect((audit?.after_state as { esol_level?: string })?.esol_level).toBe(
      "e3",
    );
  });

  it("C2 — non-adjacent jump e1→e3 → 400", async () => {
    const { org } = await createOrg();
    const admin = await createAdmin();
    const learner = await createLearner({ orgId: org._id, esolLevel: "e1" });

    await expect(
      confirmLevelChangeService(
        { learner_id: learner._id.toString(), new_level: "e3" },
        admin._id.toString(),
      ),
    ).rejects.toMatchObject({ statusCode: 400 });

    // checkLevelProgression should NOT have been called — the adjacency
    // gate runs before the readiness re-check.
    expect(checkLevelProgressionMock).not.toHaveBeenCalled();
  });

  it("C3 — demotion / same-level → 400", async () => {
    const { org } = await createOrg();
    const admin = await createAdmin();
    const learner = await createLearner({ orgId: org._id, esolLevel: "e2" });

    await expect(
      confirmLevelChangeService(
        { learner_id: learner._id.toString(), new_level: "e1" },
        admin._id.toString(),
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      confirmLevelChangeService(
        { learner_id: learner._id.toString(), new_level: "e2" },
        admin._id.toString(),
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("C4 — readiness re-check fails → 409, no LevelChange row", async () => {
    const { org } = await createOrg();
    const admin = await createAdmin();
    const learner = await createLearner({ orgId: org._id, esolLevel: "e2" });
    checkLevelProgressionMock.mockResolvedValueOnce(notReadyResult("e2"));

    await expect(
      confirmLevelChangeService(
        { learner_id: learner._id.toString(), new_level: "e3" },
        admin._id.toString(),
      ),
    ).rejects.toMatchObject({ statusCode: 409 });

    expect(await LevelChange.countDocuments({ learnerId: learner._id })).toBe(
      0,
    );
    const after = await User.findById(learner._id).lean();
    expect(after?.esolLevel).toBe("e2");
  });

  it("C5 — non-student target → 403", async () => {
    const { org } = await createOrg();
    const admin = await createAdmin();
    // A tutor, not a student
    const tutor = await User.create({
      firstname: "T",
      lastname: "U",
      email: `t-${Date.now()}@x.local`,
      password: "x",
      phoneNumber: "07000000003",
      role: "tutor",
      orgId: org._id,
      isActive: true,
      status: "active",
      verified: true,
      esolLevel: "e2",
    });

    await expect(
      confirmLevelChangeService(
        { learner_id: tutor._id.toString(), new_level: "e3" },
        admin._id.toString(),
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("C6 — learner with no orgId → 400", async () => {
    const admin = await createAdmin();
    const learner = await User.create({
      firstname: "Orphan",
      lastname: "L",
      email: `o-${Date.now()}@x.local`,
      password: "x",
      phoneNumber: "07000000004",
      role: "student",
      isActive: true,
      status: "active",
      verified: true,
      esolLevel: "e2",
    });

    await expect(
      confirmLevelChangeService(
        { learner_id: learner._id.toString(), new_level: "e3" },
        admin._id.toString(),
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("C7 — unknown new_level → 400", async () => {
    const { org } = await createOrg();
    const admin = await createAdmin();
    const learner = await createLearner({ orgId: org._id, esolLevel: "e2" });

    await expect(
      confirmLevelChangeService(
        { learner_id: learner._id.toString(), new_level: "l3" },
        admin._id.toString(),
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("C8 — confirm resets progression_notification cursor", async () => {
    const { org } = await createOrg();
    const admin = await createAdmin();
    const learner = await createLearner({
      orgId: org._id,
      esolLevel: "e2",
      notifSentAt: new Date(),
      notifLevel: "e2",
    });
    checkLevelProgressionMock.mockResolvedValueOnce(readyResult("e2"));

    await confirmLevelChangeService(
      { learner_id: learner._id.toString(), new_level: "e3" },
      admin._id.toString(),
    );

    const after = await User.findById(learner._id).lean();
    expect(after?.progression_notification_sent_at).toBeNull();
    expect(after?.progression_notification_level).toBeNull();
  });

  it("C9 — CSV-placeholder email skips the celebration email but everything else fires", async () => {
    const { org } = await createOrg();
    const admin = await createAdmin();
    const learner = await createLearner({
      orgId: org._id,
      esolLevel: "e2",
      email: "csv-placeholder-abc123def456@example.local",
    });
    checkLevelProgressionMock.mockResolvedValueOnce(readyResult("e2"));

    await confirmLevelChangeService(
      { learner_id: learner._id.toString(), new_level: "e3" },
      admin._id.toString(),
    );

    const emailCalls = notificationsAdd.mock.calls.filter(
      (c) => c[0] === "progression-confirmed-email",
    );
    expect(emailCalls).toHaveLength(0);

    // But the LevelChange row, in-app notification, and audit row still happened
    expect(await LevelChange.countDocuments({ learnerId: learner._id })).toBe(
      1,
    );
    expect(createNotificationMock).toHaveBeenCalledTimes(1);
    expect(
      await AuditLog.countDocuments({
        learner_id: learner._id,
        action: "level_change_confirmed",
      }),
    ).toBe(1);
  });
});

// ═════════════════════════════════════════════════════════════════════
// R1–R3 — reject
// ═════════════════════════════════════════════════════════════════════

describe("rejectLevelChangeService", () => {
  it("R1 — happy path: AuditLog + org-admin notif + email; learner UNCHANGED", async () => {
    const { org, adminId: orgAdminId } = await createOrg("Reject Org");
    const amberAdmin = await createAdmin();
    const learner = await createLearner({ orgId: org._id, esolLevel: "e2" });

    const res = await rejectLevelChangeService(
      {
        learner_id: learner._id.toString(),
        reason: "In-person review still pending; defer 1 week.",
      },
      amberAdmin._id.toString(),
    );

    expect(res.statusCode).toBe(200);
    expect((res.data as { current_level?: string }).current_level).toBe("e2");

    // No LevelChange row
    expect(await LevelChange.countDocuments({ learnerId: learner._id })).toBe(
      0,
    );

    // Learner state UNCHANGED
    const after = await User.findById(learner._id).lean();
    expect(after?.esolLevel).toBe("e2");

    // AuditLog row
    const audit = await AuditLog.findOne({
      learner_id: learner._id,
      action: "level_change_rejected",
    }).lean();
    expect(audit).toBeTruthy();
    expect((audit?.after_state as { reason?: string })?.reason).toBe(
      "In-person review still pending; defer 1 week.",
    );

    // Org-admin notification fired
    expect(createNotificationMock).toHaveBeenCalledTimes(1);
    expect(createNotificationMock.mock.calls[0][0].userId.toString()).toBe(
      orgAdminId.toString(),
    );
    expect(createNotificationMock.mock.calls[0][0].type).toBe(
      "progression_rejected",
    );

    // Email enqueued to org admin
    const email = notificationsAdd.mock.calls.find(
      (c) => c[0] === "progression-rejected-email",
    );
    expect(email).toBeDefined();
    expect(email![1].payload.org_admin_user_id).toBe(orgAdminId.toString());
    expect(email![1].payload.reason).toBe(
      "In-person review still pending; defer 1 week.",
    );
  });

  it("R2 — empty reason → 400", async () => {
    const { org } = await createOrg();
    const admin = await createAdmin();
    const learner = await createLearner({ orgId: org._id });

    await expect(
      rejectLevelChangeService(
        { learner_id: learner._id.toString(), reason: "   " },
        admin._id.toString(),
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("R3 — non-existent learner → 404", async () => {
    const admin = await createAdmin();
    await expect(
      rejectLevelChangeService(
        { learner_id: new Types.ObjectId().toString(), reason: "n/a" },
        admin._id.toString(),
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
