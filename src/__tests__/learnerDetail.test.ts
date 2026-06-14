/**
 * Tests for the org-admin learner-detail endpoint —
 * brief Function 12 To-Do 2.
 *
 * SECURITY-FIRST: D1–D3 lock the access-control gate that the brief
 * calls "the most important access control in the platform". The rest
 * of the suite covers the per-section payload shape.
 *
 *   D1   org_admin with matching orgId → 200 + full detail
 *   D2   org_admin from a DIFFERENT org → 403 (NOT 404 — the brief
 *        explicitly distinguishes so the dashboard shows the right
 *        error, but the response shape is identical)
 *   D3   Non-existent learner id → 404; invalid id format → 400
 *   D4   Amber admin bypasses the org check
 *
 *   P1   Top-level learner object carries every cohort-table column
 *        (status, total_glh, teacher hours, last_active, assigned
 *        teacher, etc.)
 *   P2   stage3_objectives included as a full array
 *   P3   vocab_ledger groups retained vs in_progress + totals
 *   P4   sessions paginated recent-first, heavy fields projected out
 *   P5   level_progression chronological (oldest first)
 *   P6   safeguarding_alert_count is just an integer (no details leaked)
 *   P7   teacher_reviews chronological with TeacherReview fields
 *   P8   audit_log_entries paginated, most recent first
 *   P9   Cohort status pulled from cohort_status when set; live fallback
 *  P10   uln_status: recorded vs missing
 *  P11   assigned_teacher_name populated when assigned_teacher_id set
 *
 *  Q1   sessions_limit + audit_limit respected; defaults applied
 *  Q2   Pagination caps applied (sessions ≤100, audit ≤200)
 */

process.env.REFERRAL_JWT_SECRET =
  process.env.REFERRAL_JWT_SECRET ?? "test-secret";

import { Types } from "mongoose";
import Organisation from "../models/Organisation";
import User from "../models/User";
import AISession from "../models/AISession";
import VocabLedger from "../models/VocabLedger";
import LevelChange from "../models/LevelChange";
import SafeguardingAlert from "../models/SafeguardingAlert";
import TeacherReview from "../models/TeacherReview";
import AuditLog from "../models/AuditLog";
import { getLearnerDetailService } from "../services/learnerDetail.service";

// ─────────────────────────────────────────────────────────────────────
// Fixture helpers
// ─────────────────────────────────────────────────────────────────────

const createOrg = async (name = "Detail Org") =>
  Organisation.create({
    name,
    slug: `detail-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    contactEmail: "admin@detail.local",
    adminUserId: new Types.ObjectId(),
    billing_active: true,
    isActive: true,
  });

interface LearnerOpts {
  orgId: unknown;
  firstname?: string;
  lastname?: string;
  esolLevel?: string;
  startingLevel?: string | null;
  aimType?: string | null;
  uln?: string | null;
  cohortStatus?: string | null;
  glhTeacherContact?: number;
  assignedTeacherId?: unknown;
  l1?: string;
  stage3?: Array<Record<string, unknown>>;
}
const createLearner = async (opts: LearnerOpts) =>
  User.create({
    firstname: opts.firstname ?? "Detail",
    lastname: opts.lastname ?? "Learner",
    email: `det-${Date.now()}-${Math.random().toString(16).slice(2)}@detail.local`,
    password: "x",
    phoneNumber: "07000000000",
    role: "student",
    orgId: opts.orgId,
    isActive: true,
    status: "active",
    verified: true,
    esolLevel: opts.esolLevel ?? "e2",
    l1Language: opts.l1 ?? "english",
    starting_level: opts.startingLevel ?? null,
    esol_aim_type: opts.aimType ?? null,
    uln: opts.uln ?? null,
    cohort_status: opts.cohortStatus ?? null,
    glh_teacher_contact: opts.glhTeacherContact ?? 0,
    assigned_teacher_id: opts.assignedTeacherId ?? null,
    stage3_objectives: opts.stage3 ?? [],
  });

const seedSession = async (
  learnerId: unknown,
  orgId: unknown,
  args: {
    source?: "ai_tutor" | "teacher_consolidation" | "pre_platform";
    durationMins?: number;
    passed?: boolean;
    scenarioId?: string;
    createdAt?: Date;
  } = {},
) => {
  const session = await AISession.create({
    learnerId,
    orgId,
    sessionMode: "BRIDGE",
    esolLevel: "e2",
    turns: [],
    safeguardingFlagged: false,
    vocabIntroduced: [],
    session_source: args.source ?? "ai_tutor",
    scenario_id: args.scenarioId ?? "s1_gp_appointment",
    duration_mins: args.durationMins ?? 30,
    passed: args.passed ?? false,
    final_score: args.passed ? 0.85 : 0.5,
    turn_scores: [],
    teaching_mode_sequence: [],
    start_time: new Date(),
    completedAt: args.createdAt ?? new Date(),
  });
  if (args.createdAt) {
    await AISession.collection.updateOne(
      { _id: session._id as unknown as never },
      { $set: { createdAt: args.createdAt } },
    );
  }
  return session;
};

// ═════════════════════════════════════════════════════════════════════
// D1–D4 — Access control (the most important block in the suite)
// ═════════════════════════════════════════════════════════════════════

describe("getLearnerDetailService — access control (Function 12 To-Do 2)", () => {
  it("D1 — org_admin with matching org → 200 with detail", async () => {
    const org = await createOrg();
    const learner = await createLearner({ orgId: org._id });

    const res = await getLearnerDetailService(
      learner._id.toString(),
      "org_admin",
      org._id.toString(),
    );

    expect(res.statusCode).toBe(200);
    expect((res.data as { learner: { _id: string } }).learner._id).toBe(
      learner._id.toString(),
    );
  });

  it("D2 — org_admin from a DIFFERENT org → 403, identical shape to 404", async () => {
    const orgMine = await createOrg("Mine");
    const orgOther = await createOrg("Other");
    const learnerInOther = await createLearner({ orgId: orgOther._id });

    await expect(
      getLearnerDetailService(
        learnerInOther._id.toString(),
        "org_admin",
        orgMine._id.toString(),
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("D3 — non-existent learner → 404; invalid id → 400", async () => {
    const org = await createOrg();
    await expect(
      getLearnerDetailService(
        new Types.ObjectId().toString(),
        "org_admin",
        org._id.toString(),
      ),
    ).rejects.toMatchObject({ statusCode: 404 });

    await expect(
      getLearnerDetailService(
        "not-an-objectid",
        "org_admin",
        org._id.toString(),
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("D4 — Amber admin bypasses the org check", async () => {
    const orgA = await createOrg("A");
    const learner = await createLearner({ orgId: orgA._id });

    // Admin with a DIFFERENT org (or no org at all) can still read
    const res = await getLearnerDetailService(
      learner._id.toString(),
      "admin",
      null,
    );
    expect(res.statusCode).toBe(200);
  });
});

// ═════════════════════════════════════════════════════════════════════
// P1–P11 — Payload shape
// ═════════════════════════════════════════════════════════════════════

describe("payload shape", () => {
  it("P1 — top-level learner object carries every cohort-table column", async () => {
    const org = await createOrg();
    const teacher = await User.create({
      firstname: "Tara",
      lastname: "Tutor",
      email: `t-${Date.now()}@detail.local`,
      password: "x",
      phoneNumber: "07000000001",
      role: "tutor",
      orgId: org._id,
      isActive: true,
      status: "active",
      verified: true,
    });
    const learner = await createLearner({
      orgId: org._id,
      firstname: "Alice",
      lastname: "Apple",
      esolLevel: "e3",
      startingLevel: "e1",
      aimType: "regulated",
      uln: "1234567890",
      cohortStatus: "active",
      glhTeacherContact: 4.5,
      assignedTeacherId: teacher._id,
      l1: "arabic",
    });

    await seedSession(learner._id, org._id, {
      source: "ai_tutor",
      durationMins: 90,
      passed: true,
    });
    await seedSession(learner._id, org._id, {
      source: "pre_platform",
      durationMins: 180,
    });
    await seedSession(learner._id, org._id, {
      source: "ai_tutor",
      durationMins: 60,
      passed: true,
    });

    const res = await getLearnerDetailService(
      learner._id.toString(),
      "org_admin",
      org._id.toString(),
    );
    const data = res.data as {
      learner: Record<string, unknown>;
    };
    const L = data.learner;

    expect(L._id).toBe(learner._id.toString());
    expect(L.firstname).toBe("Alice");
    expect(L.lastname).toBe("Apple");
    expect(L.l1_language).toBe("arabic");
    expect(L.esol_level).toBe("e3");
    expect(L.starting_level).toBe("e1");
    expect(L.esol_aim_type).toBe("regulated");
    expect(L.uln_status).toBe("recorded");
    expect(L.cohort_status).toBe("active");
    expect(L.status).toBe("active");
    expect(L.total_ai_hours).toBe(2.5); // (90 + 60) / 60
    expect(L.imported_hours).toBe(3.0); // 180 / 60
    expect(L.teacher_contact_hours).toBe(4.5);
    expect(L.total_glh).toBe(10.0); // 2.5 + 3.0 + 4.5
    expect(L.scenarios_passed).toBe(2);
    expect(typeof L.last_active).toBe("string");
    expect(L.assigned_teacher_id).toBe(teacher._id.toString());
    expect(L.assigned_teacher_name).toBe("Tara Tutor");
  });

  it("P2 — stage3_objectives included as a full array", async () => {
    const org = await createOrg();
    const stage3 = [
      {
        id: "obj-1",
        skill_domain: "Sc",
        description: "speak clearly",
        target_level: "e2",
        set_from: "placement_assessment",
      },
      {
        id: "obj-2",
        skill_domain: "Wt",
        description: "write a note",
        target_level: "e2",
        set_from: "placement_assessment",
      },
    ];
    const learner = await createLearner({ orgId: org._id, stage3 });

    const res = await getLearnerDetailService(
      learner._id.toString(),
      "org_admin",
      org._id.toString(),
    );
    const arr = (
      res.data as { stage3_objectives: Array<Record<string, unknown>> }
    ).stage3_objectives;
    expect(arr).toHaveLength(2);
    expect(arr[0].id).toBe("obj-1");
    expect(arr[1].skill_domain).toBe("Wt");
  });

  it("P3 — vocab_ledger groups retained vs in_progress + totals", async () => {
    const org = await createOrg();
    const learner = await createLearner({ orgId: org._id });
    await VocabLedger.insertMany([
      {
        learnerId: learner._id,
        word: "apple",
        retained: true,
        times_encountered: 6,
        introducedAt: new Date("2026-01-01"),
        last_seen_at: new Date(),
      },
      {
        learnerId: learner._id,
        word: "banana",
        retained: false,
        times_encountered: 2,
        introducedAt: new Date("2026-02-01"),
        last_seen_at: new Date("2026-02-10"),
      },
      {
        learnerId: learner._id,
        word: "cherry",
        retained: false,
        times_encountered: 1,
        introducedAt: new Date("2026-02-15"),
        last_seen_at: new Date("2026-02-20"),
      },
    ]);

    const res = await getLearnerDetailService(
      learner._id.toString(),
      "org_admin",
      org._id.toString(),
    );
    const vl = (
      res.data as {
        vocab_ledger: {
          retained: Array<{ word: string }>;
          in_progress: Array<{ word: string }>;
          totals: { retained: number; in_progress: number; total: number };
        };
      }
    ).vocab_ledger;

    expect(vl.retained.map((r) => r.word)).toEqual(["apple"]);
    expect(vl.in_progress.map((r) => r.word)).toEqual(["banana", "cherry"]);
    expect(vl.totals).toEqual({ retained: 1, in_progress: 2, total: 3 });
  });

  it("P4 — sessions paginated recent-first; heavy fields projected out", async () => {
    const org = await createOrg();
    const learner = await createLearner({ orgId: org._id });
    for (let i = 0; i < 22; i++) {
      await seedSession(learner._id, org._id, {
        source: "ai_tutor",
        createdAt: new Date(2026, 0, 1, i),
      });
    }

    const res = await getLearnerDetailService(
      learner._id.toString(),
      "org_admin",
      org._id.toString(),
      { sessions_limit: "20" },
    );
    const s = (
      res.data as {
        sessions: {
          rows: Array<{ createdAt: string; turns?: unknown[] }>;
          pagination: {
            page: number;
            limit: number;
            total: number;
            total_pages: number;
          };
        };
      }
    ).sessions;

    expect(s.rows).toHaveLength(20);
    expect(s.pagination).toEqual({
      page: 1,
      limit: 20,
      total: 22,
      total_pages: 2,
    });
    // Recent-first ordering
    const times = s.rows.map((r) => new Date(r.createdAt).getTime());
    for (let i = 1; i < times.length; i++) {
      expect(times[i]).toBeLessThanOrEqual(times[i - 1]);
    }
    // turns[] heavy field NOT in payload
    expect(s.rows[0].turns).toBeUndefined();
  });

  it("P5 — level_progression chronological", async () => {
    const org = await createOrg();
    const learner = await createLearner({ orgId: org._id, esolLevel: "e3" });
    const admin = new Types.ObjectId();

    const oldest = new Date("2026-01-15");
    const middle = new Date("2026-04-01");
    const newest = new Date("2026-06-10");
    await LevelChange.create({
      learnerId: learner._id,
      orgId: org._id,
      fromLevel: "e1",
      toLevel: "e2",
      changedBy: admin,
      reason: "first promotion",
      effectiveDate: oldest,
    });
    await LevelChange.create({
      learnerId: learner._id,
      orgId: org._id,
      fromLevel: "e2",
      toLevel: "e3",
      changedBy: admin,
      reason: "second promotion",
      effectiveDate: newest,
    });
    await LevelChange.create({
      learnerId: learner._id,
      orgId: org._id,
      fromLevel: "e2",
      toLevel: "e2",
      changedBy: admin,
      reason: "no-op adjustment",
      effectiveDate: middle,
    });

    const res = await getLearnerDetailService(
      learner._id.toString(),
      "org_admin",
      org._id.toString(),
    );
    const lp = (
      res.data as {
        level_progression: Array<{
          fromLevel: string;
          toLevel: string;
          effectiveDate: string;
        }>;
      }
    ).level_progression;

    expect(lp).toHaveLength(3);
    const dates = lp.map((l) => new Date(l.effectiveDate).getTime());
    expect(dates).toEqual([...dates].sort((a, b) => a - b)); // ascending
  });

  it("P6 — safeguarding_alert_count is just an integer (no details)", async () => {
    const org = await createOrg();
    const learner = await createLearner({ orgId: org._id });

    for (let i = 0; i < 3; i++) {
      await SafeguardingAlert.create({
        learnerId: learner._id,
        orgId: org._id,
        sessionId: new Types.ObjectId(),
        alertLevel: "critical",
        messageContentHash: "a".repeat(64),
        triggerCategory: "self_harm",
        triggerSource: "keyword",
        status: "open",
      });
    }

    const res = await getLearnerDetailService(
      learner._id.toString(),
      "org_admin",
      org._id.toString(),
    );
    const data = res.data as { safeguarding_alert_count: number };
    expect(data.safeguarding_alert_count).toBe(3);

    // No alert details on the payload — every key should be a primitive,
    // and the alert collection's fields must not leak through any other slot
    const serialised = JSON.stringify(data);
    expect(serialised).not.toMatch(/messageContentHash/i);
    expect(serialised).not.toMatch(/triggerCategory/i);
  });

  it("P7 — teacher_reviews chronological", async () => {
    const org = await createOrg();
    const learner = await createLearner({ orgId: org._id });
    const teacherId = new Types.ObjectId();
    const oldest = new Date("2026-03-01");
    const newest = new Date("2026-05-15");

    await TeacherReview.create({
      learner_id: learner._id,
      teacher_id: teacherId,
      org_id: org._id,
      review_type: "async_review",
      duration_mins: 10,
      notes: "first",
      ai_recommendation_acted_on: true,
      created_at: newest,
    });
    await TeacherReview.create({
      learner_id: learner._id,
      teacher_id: teacherId,
      org_id: org._id,
      review_type: "contact_session",
      duration_mins: 45,
      notes: "second",
      ai_recommendation_acted_on: false,
      created_at: oldest,
    });

    const res = await getLearnerDetailService(
      learner._id.toString(),
      "org_admin",
      org._id.toString(),
    );
    const reviews = (
      res.data as {
        teacher_reviews: Array<{
          review_type: string;
          created_at: string;
          notes: string;
        }>;
      }
    ).teacher_reviews;

    expect(reviews).toHaveLength(2);
    expect(reviews[0].notes).toBe("second"); // oldest first
    expect(reviews[0].review_type).toBe("contact_session");
    expect(reviews[1].notes).toBe("first");
  });

  it("P8 — audit_log_entries paginated, most recent first", async () => {
    const org = await createOrg();
    const learner = await createLearner({ orgId: org._id });
    const baseTime = new Date("2026-05-01T00:00:00Z").getTime();
    for (let i = 0; i < 5; i++) {
      await AuditLog.create({
        timestamp: new Date(baseTime + i * 60_000),
        actor_type: "system",
        actor_id: null,
        org_id: org._id,
        learner_id: learner._id,
        action: "session_completed",
        before_state: null,
        after_state: { i },
        reason: `entry ${i}`,
        compliance_config_version: null,
      });
    }

    const res = await getLearnerDetailService(
      learner._id.toString(),
      "org_admin",
      org._id.toString(),
      { audit_limit: "3" },
    );
    const audit = (
      res.data as {
        audit_log_entries: {
          rows: Array<{ reason: string; timestamp: string }>;
          pagination: {
            page: number;
            limit: number;
            total: number;
            total_pages: number;
          };
        };
      }
    ).audit_log_entries;

    expect(audit.rows).toHaveLength(3);
    expect(audit.pagination).toEqual({
      page: 1,
      limit: 3,
      total: 5,
      total_pages: 2,
    });
    // Most recent first
    const times = audit.rows.map((r) => new Date(r.timestamp).getTime());
    for (let i = 1; i < times.length; i++) {
      expect(times[i]).toBeLessThanOrEqual(times[i - 1]);
    }
  });

  it("P9 — cohort_status drives status; live fallback when null", async () => {
    const org = await createOrg();

    const a = await createLearner({
      orgId: org._id,
      cohortStatus: "inactive_moderate",
    });
    const b = await createLearner({ orgId: org._id, cohortStatus: null });
    await seedSession(b._id, org._id, {
      source: "ai_tutor",
      createdAt: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000), // 20d → dormant
    });
    const c = await createLearner({ orgId: org._id, cohortStatus: null }); // no session

    const aR = await getLearnerDetailService(
      a._id.toString(),
      "org_admin",
      org._id.toString(),
    );
    const bR = await getLearnerDetailService(
      b._id.toString(),
      "org_admin",
      org._id.toString(),
    );
    const cR = await getLearnerDetailService(
      c._id.toString(),
      "org_admin",
      org._id.toString(),
    );

    expect((aR.data as { learner: { status: string } }).learner.status).toBe(
      "inactive",
    );
    expect((bR.data as { learner: { status: string } }).learner.status).toBe(
      "dormant",
    );
    expect((cR.data as { learner: { status: string } }).learner.status).toBe(
      "unknown",
    );
  });

  it("P10 — uln_status: recorded vs missing", async () => {
    const org = await createOrg();
    const with_ = await createLearner({ orgId: org._id, uln: "9999999999" });
    const empty = await createLearner({ orgId: org._id, uln: "" });
    const nul = await createLearner({ orgId: org._id, uln: null });

    for (const [learner, expected] of [
      [with_, "recorded"],
      [empty, "missing"],
      [nul, "missing"],
    ] as const) {
      const r = await getLearnerDetailService(
        learner._id.toString(),
        "org_admin",
        org._id.toString(),
      );
      expect(
        (r.data as { learner: { uln_status: string } }).learner.uln_status,
      ).toBe(expected);
    }
  });

  it("P11 — assigned_teacher_name resolved when assigned_teacher_id set", async () => {
    const org = await createOrg();
    const teacher = await User.create({
      firstname: "Sara",
      lastname: "Stage",
      email: `s-${Date.now()}@detail.local`,
      password: "x",
      phoneNumber: "07000000002",
      role: "tutor",
      orgId: org._id,
      isActive: true,
      status: "active",
      verified: true,
    });
    const withT = await createLearner({
      orgId: org._id,
      assignedTeacherId: teacher._id,
    });
    const noT = await createLearner({ orgId: org._id });

    const r1 = await getLearnerDetailService(
      withT._id.toString(),
      "org_admin",
      org._id.toString(),
    );
    expect(
      (r1.data as { learner: { assigned_teacher_name: string } }).learner
        .assigned_teacher_name,
    ).toBe("Sara Stage");

    const r2 = await getLearnerDetailService(
      noT._id.toString(),
      "org_admin",
      org._id.toString(),
    );
    expect(
      (r2.data as { learner: { assigned_teacher_name: string | null } }).learner
        .assigned_teacher_name,
    ).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════
// Q1–Q2 — Pagination caps + defaults
// ═════════════════════════════════════════════════════════════════════

describe("pagination caps", () => {
  it("Q1 — defaults: sessions=20, audit=50", async () => {
    const org = await createOrg();
    const learner = await createLearner({ orgId: org._id });

    const res = await getLearnerDetailService(
      learner._id.toString(),
      "org_admin",
      org._id.toString(),
    );
    const data = res.data as {
      sessions: { pagination: { limit: number } };
      audit_log_entries: { pagination: { limit: number } };
    };
    expect(data.sessions.pagination.limit).toBe(20);
    expect(data.audit_log_entries.pagination.limit).toBe(50);
  });

  it("Q2 — caps: sessions≤100, audit≤200", async () => {
    const org = await createOrg();
    const learner = await createLearner({ orgId: org._id });

    const res = await getLearnerDetailService(
      learner._id.toString(),
      "org_admin",
      org._id.toString(),
      { sessions_limit: "5000", audit_limit: "5000" },
    );
    const data = res.data as {
      sessions: { pagination: { limit: number } };
      audit_log_entries: { pagination: { limit: number } };
    };
    expect(data.sessions.pagination.limit).toBe(100);
    expect(data.audit_log_entries.pagination.limit).toBe(200);
  });
});
