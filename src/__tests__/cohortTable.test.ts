/**
 * Tests for the cohort table endpoint — brief Function 12 To-Do 1
 * (with addendum teacher GLH column).
 *
 *   T1   Returns a learner with all derived columns populated correctly
 *        (live + imported hours, scenarios_passed, last_active, total_glh)
 *   T2   Scopes strictly to the caller's orgId — other-org learners hidden
 *   T3   Pagination: page + limit + total + total_pages
 *   T4   limit defaults to 50, caps at 200
 *   T5   level filter narrows the result set
 *   T6   aim_type filter narrows the result set
 *   T7   search by firstname OR lastname (case-insensitive, escape-safe)
 *   T8   status filter from cron-precomputed cohort_status
 *   T9   status filter falls back to live calculation when cohort_status is null
 *  T10   starting_level prefers earliest LevelChange.fromLevel over
 *        User.starting_level
 *  T11   uln_status: "recorded" when uln present, "missing" otherwise
 *  T12   assigned_teacher_name populated when assigned_teacher_id set
 *  T13   total_glh = total_ai_hours + imported_hours + teacher_contact_hours
 *  T14   Invalid orgId / unknown filter → 400
 *  T15   non-student + inactive learners excluded
 */

process.env.REFERRAL_JWT_SECRET = process.env.REFERRAL_JWT_SECRET ?? "test-secret";

import { Types } from "mongoose";
import Organisation from "../models/Organisation";
import User from "../models/User";
import AISession from "../models/AISession";
import LevelChange from "../models/LevelChange";
import {
  getCohortTableService,
  CohortTableRow,
} from "../services/cohortTable.service";

// ─────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────

const createOrg = async (name = "Cohort Org") =>
  Organisation.create({
    name,
    slug: `cohort-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    contactEmail: "admin@cohort.local",
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
  teacherLastReviewedAt?: Date | null;
  isActive?: boolean;
  role?: string;
}
const createLearner = async (opts: LearnerOpts) =>
  User.create({
    firstname: opts.firstname ?? "Test",
    lastname: opts.lastname ?? "Learner",
    email: `lc-${Date.now()}-${Math.random().toString(16).slice(2)}@cohort.local`,
    password: "x",
    phoneNumber: "07000000000",
    role: opts.role ?? "student",
    orgId: opts.orgId,
    isActive: opts.isActive ?? true,
    status: "active",
    verified: true,
    esolLevel: opts.esolLevel ?? "e2",
    starting_level: opts.startingLevel ?? null,
    esol_aim_type: opts.aimType ?? null,
    uln: opts.uln ?? null,
    cohort_status: opts.cohortStatus ?? null,
    glh_teacher_contact: opts.glhTeacherContact ?? 0,
    assigned_teacher_id: opts.assignedTeacherId ?? null,
    teacher_last_reviewed_at: opts.teacherLastReviewedAt ?? null,
  });

const seedSession = async (
  learnerId: unknown,
  orgId: unknown,
  args: {
    source?: "ai_tutor" | "teacher_consolidation" | "pre_platform";
    durationMins?: number;
    passed?: boolean;
    createdAt?: Date;
  } = {}
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
    duration_mins: args.durationMins ?? 30,
    passed: args.passed ?? false,
    turn_scores: [],
    teaching_mode_sequence: [],
    start_time: new Date(),
    completedAt: args.createdAt ?? new Date(),
  });
  if (args.createdAt) {
    await AISession.collection.updateOne(
      { _id: session._id as unknown as never },
      { $set: { createdAt: args.createdAt } }
    );
  }
  return session;
};

// ═════════════════════════════════════════════════════════════════════
// T1 — Happy path
// ═════════════════════════════════════════════════════════════════════

describe("getCohortTableService — derived columns", () => {
  it("T1 — populates every column from sessions / levels / teacher / GLH", async () => {
    const org = await createOrg();
    const teacher = await User.create({
      firstname: "Tara",
      lastname: "Tutor",
      email: `t-${Date.now()}@cohort.local`,
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
      teacherLastReviewedAt: new Date("2026-04-10T12:00:00Z"),
    });

    // 90 mins live + 60 mins live = 2.5 hrs ai
    await seedSession(learner._id, org._id, { source: "ai_tutor", durationMins: 90, passed: true });
    await seedSession(learner._id, org._id, {
      source: "teacher_consolidation", durationMins: 60, passed: true,
    });
    // 180 mins pre-platform = 3.0 hrs imported
    await seedSession(learner._id, org._id, { source: "pre_platform", durationMins: 180 });
    // A non-passing live session shouldn't increment scenarios_passed
    await seedSession(learner._id, org._id, {
      source: "ai_tutor", durationMins: 30, passed: false,
    });

    const res = await getCohortTableService(org._id.toString(), {});
    const data = res.data as { rows: CohortTableRow[]; pagination: unknown };
    expect(data.rows).toHaveLength(1);
    const row = data.rows[0];

    expect(row.firstname).toBe("Alice");
    expect(row.lastname).toBe("Apple");
    expect(row.esol_level).toBe("e3");
    expect(row.starting_level).toBe("e1");
    // total_ai_hours sums ALL live sessions regardless of `passed`:
    // 90 + 60 + 30 = 180 mins = 3.0 hours.
    expect(row.total_ai_hours).toBe(3.0);
    expect(row.imported_hours).toBe(3.0);
    expect(row.teacher_contact_hours).toBe(4.5);
    expect(row.total_glh).toBe(10.5);              // 3.0 + 3.0 + 4.5
    expect(row.scenarios_passed).toBe(2);          // only the two passed=true
    expect(row.last_active).toMatch(/^\d{4}-/);
    expect(row.status).toBe("active");
    expect(row.uln_status).toBe("recorded");
    expect(row.esol_aim_type).toBe("regulated");
    expect(row.assigned_teacher_id).toBe(teacher._id.toString());
    expect(row.assigned_teacher_name).toBe("Tara Tutor");
    expect(row.teacher_last_reviewed_at).toBe("2026-04-10T12:00:00.000Z");
  });
});

// ═════════════════════════════════════════════════════════════════════
// T2 — Org scoping
// ═════════════════════════════════════════════════════════════════════

describe("org scoping", () => {
  it("T2 — only the caller's org learners are visible", async () => {
    const orgMine = await createOrg("Mine");
    const orgOther = await createOrg("Other");

    await createLearner({ orgId: orgMine._id, firstname: "Me" });
    await createLearner({ orgId: orgOther._id, firstname: "NotMe1" });
    await createLearner({ orgId: orgOther._id, firstname: "NotMe2" });

    const res = await getCohortTableService(orgMine._id.toString(), {});
    const data = res.data as { rows: CohortTableRow[] };
    expect(data.rows).toHaveLength(1);
    expect(data.rows[0].firstname).toBe("Me");
  });
});

// ═════════════════════════════════════════════════════════════════════
// T3 / T4 — Pagination
// ═════════════════════════════════════════════════════════════════════

describe("pagination", () => {
  it("T3 — page + limit + total + total_pages", async () => {
    const org = await createOrg();
    for (let i = 0; i < 22; i++) {
      await createLearner({
        orgId: org._id,
        firstname: `L${i}`,
        lastname: `Last${String.fromCharCode(65 + (i % 26))}${i}`,
      });
    }

    // Brief: limit must be 10–200. Use 10 (the minimum) for a clean
    // three-page check.
    const p1 = await getCohortTableService(org._id.toString(), {
      page: "1", limit: "10",
    });
    const d1 = p1.data as { rows: CohortTableRow[]; pagination: { page: number; limit: number; total: number; total_pages: number } };
    expect(d1.rows).toHaveLength(10);
    expect(d1.pagination).toEqual({ page: 1, limit: 10, total: 22, total_pages: 3 });

    const p3 = await getCohortTableService(org._id.toString(), { page: "3", limit: "10" });
    const d3 = p3.data as { rows: CohortTableRow[]; pagination: { page: number } };
    expect(d3.rows).toHaveLength(2); // 22 - 20 = 2
    expect(d3.pagination.page).toBe(3);
  });

  it("T4 — limit defaults to 50", async () => {
    const org = await createOrg();
    await createLearner({ orgId: org._id });

    const def = await getCohortTableService(org._id.toString(), {});
    expect((def.data as { pagination: { limit: number } }).pagination.limit).toBe(50);
  });

  // ── Refinement tests: brief Function 12 pagination bounds ──────
  it("R1 — limit below MIN_PAGE_SIZE (10) → 400", async () => {
    const org = await createOrg();
    await expect(
      getCohortTableService(org._id.toString(), { limit: "5" })
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      getCohortTableService(org._id.toString(), { limit: "9" })
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("R2 — limit above MAX_PAGE_SIZE (200) → 400", async () => {
    const org = await createOrg();
    await expect(
      getCohortTableService(org._id.toString(), { limit: "201" })
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      getCohortTableService(org._id.toString(), { limit: "9999" })
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("R3 — page < 1 → 400 (covers '0' and non-numeric)", async () => {
    const org = await createOrg();
    await expect(
      getCohortTableService(org._id.toString(), { page: "0" })
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      getCohortTableService(org._id.toString(), { page: "abc" })
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("R4 — limit at the bounds (10 and 200) is accepted", async () => {
    const org = await createOrg();
    await createLearner({ orgId: org._id });

    const lo = await getCohortTableService(org._id.toString(), { limit: "10" });
    expect((lo.data as { pagination: { limit: number } }).pagination.limit).toBe(10);

    const hi = await getCohortTableService(org._id.toString(), { limit: "200" });
    expect((hi.data as { pagination: { limit: number } }).pagination.limit).toBe(200);
  });
});

// ═════════════════════════════════════════════════════════════════════
// R5–R7 — search + status interaction
// ═════════════════════════════════════════════════════════════════════

describe("refinements: status + search interaction", () => {
  it("R5 — status filter combines with search via $and (both narrow)", async () => {
    const org = await createOrg();
    // Two "Ahmed"s — one active, one dormant
    await createLearner({
      orgId: org._id, firstname: "Ahmed", lastname: "Active",
      cohortStatus: "active",
    });
    await createLearner({
      orgId: org._id, firstname: "Ahmed", lastname: "Dormant",
      cohortStatus: "dormant",
    });
    // Distractor with a different name + matching status
    await createLearner({
      orgId: org._id, firstname: "Beatrice", lastname: "Active",
      cohortStatus: "active",
    });

    const res = await getCohortTableService(org._id.toString(), {
      search: "ahmed",
      status: "active",
    });
    const rows = (res.data as { rows: CohortTableRow[] }).rows;
    // Only "Ahmed Active" should remain — the search AND the status
    // filter both have to be satisfied.
    expect(rows).toHaveLength(1);
    expect(rows[0].firstname).toBe("Ahmed");
    expect(rows[0].lastname).toBe("Active");
  });

  it("R6 — search below MIN_SEARCH_LENGTH (2) is silently dropped", async () => {
    const org = await createOrg();
    await createLearner({ orgId: org._id, firstname: "Alice" });
    await createLearner({ orgId: org._id, firstname: "Bob" });

    // 1-char "a" would match Alice via regex but the service drops it.
    const res = await getCohortTableService(org._id.toString(), { search: "a" });
    expect((res.data as { pagination: { total: number } }).pagination.total).toBe(2);
  });

  it("R7 — whitespace-only search is treated as no search", async () => {
    const org = await createOrg();
    await createLearner({ orgId: org._id, firstname: "Alice" });
    await createLearner({ orgId: org._id, firstname: "Bob" });

    const res = await getCohortTableService(org._id.toString(), { search: "   " });
    expect((res.data as { pagination: { total: number } }).pagination.total).toBe(2);
  });
});

// ═════════════════════════════════════════════════════════════════════
// T5 / T6 / T7 — Filters
// ═════════════════════════════════════════════════════════════════════

describe("filters", () => {
  it("T5 — level filter narrows the result set", async () => {
    const org = await createOrg();
    await createLearner({ orgId: org._id, esolLevel: "e2", lastname: "AtE2" });
    await createLearner({ orgId: org._id, esolLevel: "e3", lastname: "AtE3" });
    await createLearner({ orgId: org._id, esolLevel: "e3", lastname: "AtE3b" });

    const res = await getCohortTableService(org._id.toString(), { level: "e3" });
    const data = res.data as { rows: CohortTableRow[]; pagination: { total: number } };
    expect(data.pagination.total).toBe(2);
    expect(data.rows.every((r) => r.esol_level === "e3")).toBe(true);
  });

  it("T6 — aim_type filter", async () => {
    const org = await createOrg();
    await createLearner({ orgId: org._id, aimType: "regulated", lastname: "R" });
    await createLearner({ orgId: org._id, aimType: "non_regulated", lastname: "NR" });
    await createLearner({ orgId: org._id, aimType: null, lastname: "Null" });

    const reg = await getCohortTableService(org._id.toString(), { aim_type: "regulated" });
    expect((reg.data as { pagination: { total: number } }).pagination.total).toBe(1);
    const nr = await getCohortTableService(org._id.toString(), { aim_type: "non_regulated" });
    expect((nr.data as { pagination: { total: number } }).pagination.total).toBe(1);
  });

  it("T7 — search matches firstname OR lastname, case-insensitively, escape-safe", async () => {
    const org = await createOrg();
    await createLearner({ orgId: org._id, firstname: "Ahmed", lastname: "Said" });
    await createLearner({ orgId: org._id, firstname: "Beatrice", lastname: "Aiyad" });
    await createLearner({ orgId: org._id, firstname: "Charlie", lastname: "Ord" });

    const ahm = await getCohortTableService(org._id.toString(), { search: "ahm" });
    expect((ahm.data as { pagination: { total: number } }).pagination.total).toBe(1);

    // Case insensitive lastname match
    const aiy = await getCohortTableService(org._id.toString(), { search: "AIY" });
    expect((aiy.data as { pagination: { total: number } }).pagination.total).toBe(1);

    // Regex specials must be escaped — a dot shouldn't act as wildcard
    const dot = await getCohortTableService(org._id.toString(), { search: "A.med" });
    expect((dot.data as { pagination: { total: number } }).pagination.total).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════════════
// T8 / T9 — Status sourcing
// ═════════════════════════════════════════════════════════════════════

describe("status derivation", () => {
  it("T8 — prefers cron-precomputed cohort_status", async () => {
    const org = await createOrg();
    await createLearner({
      orgId: org._id, lastname: "ActA", cohortStatus: "active",
    });
    await createLearner({
      orgId: org._id, lastname: "InactiveMild", cohortStatus: "inactive_mild",
    });
    await createLearner({
      orgId: org._id, lastname: "DormantD", cohortStatus: "dormant",
    });

    const act = await getCohortTableService(org._id.toString(), { status: "active" });
    expect((act.data as { rows: CohortTableRow[] }).rows.map((r) => r.lastname)).toEqual(["ActA"]);

    const inact = await getCohortTableService(org._id.toString(), { status: "inactive" });
    expect((inact.data as { rows: CohortTableRow[] }).rows.map((r) => r.lastname)).toEqual([
      "InactiveMild",
    ]);

    const dorm = await getCohortTableService(org._id.toString(), { status: "dormant" });
    expect((dorm.data as { rows: CohortTableRow[] }).rows.map((r) => r.lastname)).toEqual([
      "DormantD",
    ]);
  });

  it("T9 — falls back to live calculation when cohort_status is null", async () => {
    const org = await createOrg();
    // No cron has run yet → cohort_status is null. last_active is computed
    // from AISession.createdAt.
    const fresh = await createLearner({ orgId: org._id, lastname: "Fresh" });
    await seedSession(fresh._id, org._id, {
      source: "ai_tutor",
      durationMins: 10,
      createdAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000), // 3 days ago
    });

    const stale = await createLearner({ orgId: org._id, lastname: "Stale" });
    await seedSession(stale._id, org._id, {
      source: "ai_tutor",
      durationMins: 10,
      createdAt: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000), // 20 days ago
    });

    const neverActive = await createLearner({ orgId: org._id, lastname: "NeverActive" });
    expect(neverActive).toBeTruthy();

    const all = await getCohortTableService(org._id.toString(), {});
    const rows = (all.data as { rows: CohortTableRow[] }).rows;
    const byName = new Map(rows.map((r) => [r.lastname, r]));
    expect(byName.get("Fresh")?.status).toBe("active");
    expect(byName.get("Stale")?.status).toBe("dormant");
    expect(byName.get("NeverActive")?.status).toBe("unknown");
  });
});

// ═════════════════════════════════════════════════════════════════════
// T10 — starting_level precedence
// ═════════════════════════════════════════════════════════════════════

describe("starting_level derivation", () => {
  it("T10 — uses earliest LevelChange.fromLevel, falls back to User.starting_level", async () => {
    const org = await createOrg();
    const a = await createLearner({
      orgId: org._id, lastname: "A_HasChange",
      esolLevel: "e3", startingLevel: "e1",
    });
    // Earliest LevelChange says fromLevel e2; that should override starting_level
    await LevelChange.create({
      learnerId: a._id, orgId: org._id,
      fromLevel: "e2", toLevel: "e3",
      changedBy: new Types.ObjectId(),
      reason: "promotion",
      effectiveDate: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    });

    const b = await createLearner({
      orgId: org._id, lastname: "B_NoChange",
      esolLevel: "e1", startingLevel: "e1",
    });
    expect(b).toBeTruthy();

    const res = await getCohortTableService(org._id.toString(), {});
    const rows = (res.data as { rows: CohortTableRow[] }).rows;
    const byName = new Map(rows.map((r) => [r.lastname, r]));
    expect(byName.get("A_HasChange")?.starting_level).toBe("e2");
    expect(byName.get("B_NoChange")?.starting_level).toBe("e1");
  });
});

// ═════════════════════════════════════════════════════════════════════
// T11 — uln_status
// ═════════════════════════════════════════════════════════════════════

describe("uln_status", () => {
  it("T11 — 'recorded' when uln present, 'missing' otherwise", async () => {
    const org = await createOrg();
    await createLearner({ orgId: org._id, lastname: "Has", uln: "9999999999" });
    await createLearner({ orgId: org._id, lastname: "Empty", uln: "" });
    await createLearner({ orgId: org._id, lastname: "Null", uln: null });

    const res = await getCohortTableService(org._id.toString(), {});
    const rows = (res.data as { rows: CohortTableRow[] }).rows;
    const byName = new Map(rows.map((r) => [r.lastname, r]));
    expect(byName.get("Has")?.uln_status).toBe("recorded");
    expect(byName.get("Empty")?.uln_status).toBe("missing");
    expect(byName.get("Null")?.uln_status).toBe("missing");
  });
});

// ═════════════════════════════════════════════════════════════════════
// T12 — assigned_teacher join
// ═════════════════════════════════════════════════════════════════════

describe("assigned_teacher", () => {
  it("T12 — name populated, null when no teacher assigned", async () => {
    const org = await createOrg();
    const teacher = await User.create({
      firstname: "Sara", lastname: "Stage",
      email: `s-${Date.now()}@cohort.local`,
      password: "x", phoneNumber: "07000000002",
      role: "tutor", orgId: org._id,
      isActive: true, status: "active", verified: true,
    });
    await createLearner({
      orgId: org._id, lastname: "WithTeacher", assignedTeacherId: teacher._id,
    });
    await createLearner({ orgId: org._id, lastname: "NoTeacher" });

    const res = await getCohortTableService(org._id.toString(), {});
    const rows = (res.data as { rows: CohortTableRow[] }).rows;
    const byName = new Map(rows.map((r) => [r.lastname, r]));
    expect(byName.get("WithTeacher")?.assigned_teacher_id).toBe(teacher._id.toString());
    expect(byName.get("WithTeacher")?.assigned_teacher_name).toBe("Sara Stage");
    expect(byName.get("NoTeacher")?.assigned_teacher_id).toBeNull();
    expect(byName.get("NoTeacher")?.assigned_teacher_name).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════
// T13 — total_glh
// ═════════════════════════════════════════════════════════════════════

describe("total_glh", () => {
  it("T13 — sums ai + imported + teacher_contact_hours", async () => {
    const org = await createOrg();
    const learner = await createLearner({
      orgId: org._id,
      glhTeacherContact: 2.0,
    });
    await seedSession(learner._id, org._id, {
      source: "ai_tutor", durationMins: 60,
    });
    await seedSession(learner._id, org._id, {
      source: "pre_platform", durationMins: 90,
    });

    const res = await getCohortTableService(org._id.toString(), {});
    const row = (res.data as { rows: CohortTableRow[] }).rows[0];
    expect(row.total_ai_hours).toBe(1.0);
    expect(row.imported_hours).toBe(1.5);
    expect(row.teacher_contact_hours).toBe(2.0);
    expect(row.total_glh).toBe(4.5);
  });
});

// ═════════════════════════════════════════════════════════════════════
// Final Addendum §12 — Last Reviewed column
// ═════════════════════════════════════════════════════════════════════

describe("teacher_last_reviewed_at — Final Addendum §12", () => {
  it("S1 — sourced from User.teacher_last_reviewed_at as ISO string", async () => {
    const org = await createOrg();
    const reviewedAt = new Date("2026-04-12T10:00:00Z");
    await createLearner({
      orgId: org._id,
      lastname: "WithReview",
      teacherLastReviewedAt: reviewedAt,
    });
    await createLearner({
      orgId: org._id,
      lastname: "NoReview",
    });

    const res = await getCohortTableService(org._id.toString(), {});
    const rows = (res.data as { rows: CohortTableRow[] }).rows;
    const byName = new Map(rows.map((r) => [r.lastname, r]));
    expect(byName.get("WithReview")?.teacher_last_reviewed_at).toBe(
      reviewedAt.toISOString()
    );
    expect(byName.get("NoReview")?.teacher_last_reviewed_at).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════
// T14 — Validation
// ═════════════════════════════════════════════════════════════════════

describe("validation", () => {
  it("T14 — invalid orgId → 400", async () => {
    await expect(
      getCohortTableService("not-an-objectid", {})
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("T14.b — unknown filter values → 400", async () => {
    const org = await createOrg();
    await expect(
      getCohortTableService(org._id.toString(), { status: "weird" })
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      getCohortTableService(org._id.toString(), { level: "e7" })
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      getCohortTableService(org._id.toString(), { aim_type: "tax-free" })
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

// ═════════════════════════════════════════════════════════════════════
// T15 — Cohort membership
// ═════════════════════════════════════════════════════════════════════

describe("cohort membership", () => {
  it("T15 — non-student + isActive=false excluded", async () => {
    const org = await createOrg();
    await createLearner({ orgId: org._id, lastname: "Active" });
    await createLearner({ orgId: org._id, lastname: "Deactivated", isActive: false });
    await createLearner({ orgId: org._id, lastname: "TutorImpostor", role: "tutor" });

    const res = await getCohortTableService(org._id.toString(), {});
    const rows = (res.data as { rows: CohortTableRow[] }).rows;
    expect(rows.map((r) => r.lastname)).toEqual(["Active"]);
  });
});
