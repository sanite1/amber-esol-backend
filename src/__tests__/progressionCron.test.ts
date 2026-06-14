/**
 * Tests for the daily progression cron + per-org worker —
 * brief Function 11.
 *
 *   F1  fanOutProgressionCheck enqueues one job per org with active learners
 *   F2  fanOutProgressionCheck job ids are deterministic (date+org) → no dupes
 *   F3  fanOutProgressionCheck ignores orgs with no active students
 *
 *   W1  runOrgProgressionCheck: ready learner → in-app notification + email
 *       enqueued + progression_notification_sent_at + progression_notification_level
 *       stamped + AuditLog "progression_ready_flagged"
 *   W2  Dedupe — second run within 7d at same level skips the notification
 *   W3  Dedupe resets when learner's level changes (different progression_level)
 *   W4  Not-ready learner produces no notification / no audit row
 *   W5  cohort_status moves 14d→inactive_mild + AuditLog "cohort_status_changed"
 *   W6  decideCohortStatus pure function — all bands
 *   W7  Per-learner failure is counted, run continues for the rest of the org
 */

process.env.REFERRAL_JWT_SECRET =
  process.env.REFERRAL_JWT_SECRET ?? "test-secret";

// Queue mocks — capture .add() calls
const priorityAdd = jest.fn().mockResolvedValue({ id: "fake" });
const notificationsAdd = jest.fn().mockResolvedValue({ id: "fake" });
const esolSessionAdd = jest.fn().mockResolvedValue({ id: "fake" });
jest.mock("../queues", () => ({
  __esModule: true,
  priorityQueueQueue: { add: priorityAdd },
  notificationsQueue: { add: notificationsAdd },
  esolSessionQueue: { add: esolSessionAdd },
}));

// Notification.create side-effect via the helper — mock to a spy
const createNotificationMock = jest.fn().mockResolvedValue(undefined);
jest.mock("../services/notification.service", () => ({
  __esModule: true,
  createNotification: createNotificationMock,
}));

import { Types } from "mongoose";
import Organisation from "../models/Organisation";
import User from "../models/User";
import AISession from "../models/AISession";
import AuditLog from "../models/AuditLog";
import {
  fanOutProgressionCheck,
  runOrgProgressionCheck,
  decideCohortStatus,
  __internals__,
} from "../services/progressionCron.service";

// ─────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────

const createOrg = async (name = "PC Org") => {
  const adminId = new Types.ObjectId();
  await User.create({
    _id: adminId,
    firstname: "Org",
    lastname: "Admin",
    email: `admin-${Date.now()}-${Math.random().toString(16).slice(2)}@pc.local`,
    password: "x",
    phoneNumber: "07000000099",
    role: "org_admin",
    isActive: true,
    status: "active",
    verified: true,
  });
  const org = await Organisation.create({
    name,
    slug: `pc-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    contactEmail: "admin@pc.local",
    adminUserId: adminId,
    billing_active: true,
    isActive: true,
  });
  return { org, adminId };
};

interface LearnerOpts {
  esolLevel?: string;
  createdAt?: Date;
  notifSentAt?: Date | null;
  notifLevel?: string | null;
  cohort?: string;
}
const createLearner = async (orgId: unknown, opts: LearnerOpts = {}) => {
  const learner = await User.create({
    firstname: "PC",
    lastname: "Learner",
    email: `learner-${Date.now()}-${Math.random().toString(16).slice(2)}@pc.local`,
    password: "x",
    phoneNumber: "07000000000",
    role: "student",
    orgId,
    isActive: true,
    status: "active",
    verified: true,
    esolLevel: opts.esolLevel ?? "e2",
    l1Language: "english",
    cohort_status: opts.cohort ?? "active",
    progression_notification_sent_at: opts.notifSentAt ?? null,
    progression_notification_level: opts.notifLevel ?? null,
  });
  if (opts.createdAt) {
    await User.collection.updateOne(
      { _id: learner._id as unknown as never },
      { $set: { createdAt: opts.createdAt } },
    );
  }
  return learner;
};

const seedPassingSession = async (
  learnerId: unknown,
  orgId: unknown,
  scenarioId: string,
  completedAt: Date,
  skillCodes: string[] = ["Sc", "Lr", "Rt", "Wt"],
) => {
  const s = await AISession.create({
    learnerId,
    orgId,
    sessionMode: "BRIDGE",
    esolLevel: "e2",
    nqf_level_at_start: "e2",
    turns: [],
    safeguardingFlagged: false,
    vocabIntroduced: [],
    session_source: "ai_tutor",
    scenario_id: scenarioId,
    final_score: 0.85,
    passed: true,
    skill_codes_covered: skillCodes,
    turn_scores: [],
    teaching_mode_sequence: ["bridge", "bridge"],
    start_time: new Date(),
    completedAt,
  });
  await AISession.collection.updateOne(
    { _id: s._id as unknown as never },
    { $set: { completedAt } },
  );
  return s;
};

// Three passing sessions covering 4 domains
const seedReadyHistory = async (learnerId: unknown, orgId: unknown) => {
  await seedPassingSession(
    learnerId,
    orgId,
    "s1_gp_appointment",
    new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
    ["Sc", "Lr"],
  );
  await seedPassingSession(
    learnerId,
    orgId,
    "s2_payslip",
    new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
    ["Rt", "Wt"],
  );
  await seedPassingSession(
    learnerId,
    orgId,
    "s3_housing_rights",
    new Date(Date.now() - 1 * 24 * 60 * 60 * 1000),
    ["Sc", "Lr", "Rt"],
  );
};

beforeEach(() => {
  priorityAdd.mockClear();
  notificationsAdd.mockClear();
  esolSessionAdd.mockClear();
  createNotificationMock.mockClear();
});

// ═════════════════════════════════════════════════════════════════════
// F1–F3 — fan-out
// ═════════════════════════════════════════════════════════════════════

describe("fanOutProgressionCheck", () => {
  it("F1 — one job per org with active learners", async () => {
    const { org: orgA } = await createOrg("Org A");
    const { org: orgB } = await createOrg("Org B");
    await createLearner(orgA._id);
    await createLearner(orgB._id);

    const res = await fanOutProgressionCheck();
    expect(res.orgs_with_active_learners).toBe(2);
    expect(res.jobs_enqueued).toBe(2);
    expect(priorityAdd).toHaveBeenCalledTimes(2);

    for (const call of priorityAdd.mock.calls) {
      const [name, payload, opts] = call;
      expect(name).toBe("check-progression");
      expect(payload.action).toBe("check-progression");
      expect(payload.triggerEvent).toBe("scheduled");
      expect(typeof payload.orgId).toBe("string");
      expect(opts.jobId).toMatch(/^progression:\d{4}-\d{2}-\d{2}:/);
    }
  });

  it("F2 — job ids are deterministic per (date, org) — no dupes", async () => {
    const { org } = await createOrg("Det Org");
    await createLearner(org._id);

    await fanOutProgressionCheck();
    await fanOutProgressionCheck();

    expect(priorityAdd).toHaveBeenCalledTimes(2);
    const j1 = priorityAdd.mock.calls[0][2].jobId;
    const j2 = priorityAdd.mock.calls[1][2].jobId;
    expect(j1).toBe(j2);
  });

  it("F3 — orgs with no active students get no job", async () => {
    const { org: emptyOrg } = await createOrg("Empty");
    const { org: liveOrg } = await createOrg("Live");
    await createLearner(liveOrg._id);
    // emptyOrg has no learners

    const res = await fanOutProgressionCheck();
    expect(res.orgs_with_active_learners).toBe(1);
    expect(res.org_ids).toContain(liveOrg._id.toString());
    expect(res.org_ids).not.toContain(emptyOrg._id.toString());
  });
});

// ═════════════════════════════════════════════════════════════════════
// W1–W4 — readiness + notification + dedupe
// ═════════════════════════════════════════════════════════════════════

describe("runOrgProgressionCheck", () => {
  it("W1 — ready learner: notification + email + stamp + audit", async () => {
    const { org } = await createOrg();
    const learner = await createLearner(org._id, {
      createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    });
    await seedReadyHistory(learner._id, org._id);

    const stats = await runOrgProgressionCheck(org._id.toString());

    expect(stats.learners_checked).toBe(1);
    expect(stats.ready_flagged).toBe(1);
    expect(stats.notifications_sent).toBe(1);
    expect(stats.notifications_deduped).toBe(0);

    // In-app notification fired to org admin
    expect(createNotificationMock).toHaveBeenCalledTimes(1);
    const notif = createNotificationMock.mock.calls[0][0];
    expect(notif.type).toBe("progression_ready");
    expect(notif.title).toMatch(/level review/i);
    expect(notif.data.learner_id).toBe(learner._id.toString());
    expect(notif.data.current_level).toBe("e2");

    // Email enqueued
    const emailCalls = notificationsAdd.mock.calls.filter(
      (c) => c[0] === "progression-ready-email",
    );
    expect(emailCalls).toHaveLength(1);
    expect(emailCalls[0][1].payload.current_level).toBe("e2");

    // User stamp
    const stamped = await User.findById(learner._id).lean();
    expect(stamped?.progression_notification_sent_at).toBeInstanceOf(Date);
    expect(stamped?.progression_notification_level).toBe("e2");

    // AuditLog row
    const audit = await AuditLog.findOne({
      learner_id: learner._id,
      action: "progression_ready_flagged",
    }).lean();
    expect(audit).toBeTruthy();
    expect(
      (audit?.after_state as { current_level?: string })?.current_level,
    ).toBe("e2");
  });

  it("W2 — second run within 7d at same level → deduped, no second email", async () => {
    const { org } = await createOrg();
    const yesterday = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000);
    const learner = await createLearner(org._id, {
      createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      notifSentAt: yesterday,
      notifLevel: "e2",
    });
    await seedReadyHistory(learner._id, org._id);

    const stats = await runOrgProgressionCheck(org._id.toString());

    expect(stats.ready_flagged).toBe(1);
    expect(stats.notifications_deduped).toBe(1);
    expect(stats.notifications_sent).toBe(0);
    expect(createNotificationMock).not.toHaveBeenCalled();
    expect(
      notificationsAdd.mock.calls.filter(
        (c) => c[0] === "progression-ready-email",
      ),
    ).toHaveLength(0);
  });

  it("W3 — dedupe resets when learner's level differs from last notif", async () => {
    const { org } = await createOrg();
    // Learner was notified yesterday at e1; now they're at e2 → should re-fire
    const yesterday = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000);
    const learner = await createLearner(org._id, {
      esolLevel: "e2",
      createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      notifSentAt: yesterday,
      notifLevel: "e1", // ← different from current e2
    });
    await seedReadyHistory(learner._id, org._id);

    const stats = await runOrgProgressionCheck(org._id.toString());
    expect(stats.notifications_sent).toBe(1);
    expect(stats.notifications_deduped).toBe(0);
  });

  it("W4 — not-ready learner produces no notification / no audit row", async () => {
    const { org } = await createOrg();
    const learner = await createLearner(org._id, {
      createdAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000), // 5 days < 14 → fails C5
    });
    await seedReadyHistory(learner._id, org._id);

    const stats = await runOrgProgressionCheck(org._id.toString());
    expect(stats.ready_flagged).toBe(0);
    expect(stats.notifications_sent).toBe(0);
    expect(createNotificationMock).not.toHaveBeenCalled();

    const audit = await AuditLog.findOne({
      learner_id: learner._id,
      action: "progression_ready_flagged",
    }).lean();
    expect(audit).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════
// W5–W6 — cohort_status
// ═════════════════════════════════════════════════════════════════════

describe("cohort_status sweep", () => {
  it("W5 — learner with last session 20 days ago → dormant + audit row + digest email", async () => {
    const { org } = await createOrg();
    const learner = await createLearner(org._id, {
      createdAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000),
      cohort: "active",
    });
    await seedPassingSession(
      learner._id,
      org._id,
      "s1_gp_appointment",
      new Date(Date.now() - 20 * 24 * 60 * 60 * 1000),
    );

    const stats = await runOrgProgressionCheck(org._id.toString());

    const updated = await User.findById(learner._id).lean();
    expect(updated?.cohort_status).toBe("dormant");
    expect(updated?.last_session_at).toBeInstanceOf(Date);

    const audit = await AuditLog.findOne({
      learner_id: learner._id,
      action: "cohort_status_changed",
    }).lean();
    expect(audit).toBeTruthy();
    const after = audit?.after_state as {
      cohort_status?: string;
      days_since_last_session?: number;
    };
    expect(after?.cohort_status).toBe("dormant");
    expect(after?.days_since_last_session).toBe(20);

    // Function 12 To-Do 4 — digest email fires when there's ≥1 dormant
    expect(stats.dormant_learners_count).toBe(1);
    expect(stats.dormant_digest_email_sent).toBe(true);
    const emailCall = notificationsAdd.mock.calls.find(
      (c) => c[0] === "dormant-learners-digest-email",
    );
    expect(emailCall).toBeDefined();
    expect(emailCall![1].payload.dormant_count).toBe(1);
  });

  it("W5.b — no dormant learners → no digest email enqueued", async () => {
    const { org } = await createOrg();
    const learner = await createLearner(org._id, {
      createdAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000),
    });
    await seedPassingSession(
      learner._id,
      org._id,
      "s1_gp_appointment",
      new Date(Date.now() - 2 * 24 * 60 * 60 * 1000), // 2 days ago → active
    );

    const stats = await runOrgProgressionCheck(org._id.toString());
    expect(stats.dormant_learners_count).toBe(0);
    expect(stats.dormant_digest_email_sent).toBe(false);
    const emailCalls = notificationsAdd.mock.calls.filter(
      (c) => c[0] === "dormant-learners-digest-email",
    );
    expect(emailCalls).toHaveLength(0);
  });

  it("W6 — decideCohortStatus covers every brief Function 12 To-Do 4 band", () => {
    // 0–4: active
    expect(decideCohortStatus(0, 100)).toBe("active");
    expect(decideCohortStatus(4, 100)).toBe("active");
    // 5–9: inactive_mild
    expect(decideCohortStatus(5, 100)).toBe("inactive_mild");
    expect(decideCohortStatus(9, 100)).toBe("inactive_mild");
    // 10–14: inactive_moderate
    expect(decideCohortStatus(10, 100)).toBe("inactive_moderate");
    expect(decideCohortStatus(14, 100)).toBe("inactive_moderate");
    // 15+: dormant
    expect(decideCohortStatus(15, 100)).toBe("dormant");
    expect(decideCohortStatus(100, 100)).toBe("dormant");

    // No session yet
    expect(decideCohortStatus(null, 3)).toBe("new"); // enrolled ≤ 4 days
    expect(decideCohortStatus(null, 5)).toBe("inactive_mild"); // enrolled > 4 days
  });
});

// ═════════════════════════════════════════════════════════════════════
// W7 — resilience
// ═════════════════════════════════════════════════════════════════════

describe("per-learner failure handling", () => {
  it("W7 — one bad learner doesn't kill the org's run", async () => {
    const { org } = await createOrg();
    // Learner A is ready
    const learnerA = await createLearner(org._id, {
      createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    });
    await seedReadyHistory(learnerA._id, org._id);

    // Learner B will throw — force createNotification to throw once
    const learnerB = await createLearner(org._id, {
      createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    });
    await seedReadyHistory(learnerB._id, org._id);

    createNotificationMock
      .mockRejectedValueOnce(new Error("synthetic notif failure"))
      .mockResolvedValue(undefined);

    const stats = await runOrgProgressionCheck(org._id.toString());
    expect(stats.learners_checked).toBe(2);
    expect(stats.errors).toBe(1);
    // The other learner still got their notification
    expect(stats.notifications_sent).toBe(1);
  });
});

// ═════════════════════════════════════════════════════════════════════
// Internal helpers
// ═════════════════════════════════════════════════════════════════════

describe("isWithinDedupWindow", () => {
  const { isWithinDedupWindow, NOTIFICATION_DEDUP_WINDOW_MS } = __internals__;
  const now = Date.now();

  it("no prior send → not deduped", () => {
    expect(isWithinDedupWindow(null, null, "e2", now)).toBe(false);
  });
  it("same level within 7d → deduped", () => {
    const recent = new Date(now - 2 * 24 * 60 * 60 * 1000);
    expect(isWithinDedupWindow(recent, "e2", "e2", now)).toBe(true);
  });
  it("same level beyond 7d → not deduped", () => {
    const old = new Date(now - NOTIFICATION_DEDUP_WINDOW_MS - 1);
    expect(isWithinDedupWindow(old, "e2", "e2", now)).toBe(false);
  });
  it("different level within 7d → not deduped", () => {
    const recent = new Date(now - 2 * 24 * 60 * 60 * 1000);
    expect(isWithinDedupWindow(recent, "e1", "e2", now)).toBe(false);
  });
});
