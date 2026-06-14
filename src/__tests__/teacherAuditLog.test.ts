/**
 * Tests for GET /api/teacher/learners/:id/audit-log — Final Addendum §6
 * (BE-C). Teacher-scoped audit log for one of their assigned learners.
 *
 *   T1   Assignment gate — assigned learner: rows returned
 *   T2   Assignment gate — non-assigned learner: 403
 *   T3   Assignment gate — non-existent / non-student id: 404
 *   T4   Sorted by timestamp desc
 *   T5   Org-scope defence-in-depth: even if some other-org row
 *        somehow shared the learner_id, the org_id pin excludes it
 *   T6   action + date filters narrow the result set
 *   T7   reason field returned verbatim
 */

process.env.REFERRAL_JWT_SECRET =
  process.env.REFERRAL_JWT_SECRET ?? "test-secret";

import { Types } from "mongoose";
import Organisation from "../models/Organisation";
import User from "../models/User";
import AuditLog from "../models/AuditLog";
import { listTeacherAuditLogService } from "../services/teacherAuditLog.service";

// ─────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────

const createOrg = async (name = "Teacher Audit Org") =>
  Organisation.create({
    name,
    slug: `tal-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    contactEmail: "admin@tal.local",
    adminUserId: new Types.ObjectId(),
    billing_active: true,
    isActive: true,
  });

const createUser = async (
  orgId: unknown,
  opts: {
    role?: string;
    firstname?: string;
    assigned_teacher_id?: unknown;
  } = {},
) =>
  User.create({
    firstname: opts.firstname ?? "Test",
    lastname: "User",
    email: `tu-${Date.now()}-${Math.random().toString(16).slice(2)}@tal.local`,
    password: "x",
    phoneNumber: "07000000000",
    role: opts.role ?? "student",
    orgId,
    isActive: true,
    status: "active",
    verified: true,
    ...(opts.assigned_teacher_id !== undefined
      ? { assigned_teacher_id: opts.assigned_teacher_id }
      : {}),
  });

interface SeedAuditArgs {
  orgId: unknown;
  learnerId: unknown;
  action?: string;
  reason?: string;
  timestamp?: Date;
}
const seedAudit = (args: SeedAuditArgs) =>
  AuditLog.create({
    timestamp: args.timestamp ?? new Date(),
    actor_type: "system",
    actor_id: null,
    org_id: args.orgId,
    learner_id: args.learnerId,
    action: args.action ?? "session_completed",
    before_state: null,
    after_state: null,
    reason: args.reason ?? "default reason",
    compliance_config_version: null,
  });

// ═════════════════════════════════════════════════════════════════════

describe("listTeacherAuditLogService", () => {
  it("T1 — assigned learner: rows returned", async () => {
    const org = await createOrg();
    const teacher = await createUser(org._id, {
      role: "tutor",
      firstname: "Teach",
    });
    const learner = await createUser(org._id, {
      assigned_teacher_id: teacher._id,
    });
    await seedAudit({
      orgId: org._id,
      learnerId: learner._id,
      reason: "row 1",
    });
    await seedAudit({
      orgId: org._id,
      learnerId: learner._id,
      reason: "row 2",
    });

    const res = await listTeacherAuditLogService(
      teacher._id.toString(),
      learner._id.toString(),
      {},
    );
    const data = res.data as {
      rows: Array<{ reason: string }>;
      pagination: { total: number };
    };
    expect(data.pagination.total).toBe(2);
    expect(data.rows.map((r) => r.reason).sort()).toEqual(["row 1", "row 2"]);
  });

  it("T2 — learner not assigned to this teacher → 403", async () => {
    const org = await createOrg();
    const teacherMine = await createUser(org._id, { role: "tutor" });
    const teacherOther = await createUser(org._id, { role: "tutor" });
    const learner = await createUser(org._id, {
      assigned_teacher_id: teacherOther._id,
    });
    await seedAudit({ orgId: org._id, learnerId: learner._id });

    await expect(
      listTeacherAuditLogService(
        teacherMine._id.toString(),
        learner._id.toString(),
        {},
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("T3 — non-existent learner id → 404; non-student id → 404", async () => {
    const org = await createOrg();
    const teacher = await createUser(org._id, { role: "tutor" });

    // Non-existent ObjectId
    await expect(
      listTeacherAuditLogService(
        teacher._id.toString(),
        new Types.ObjectId().toString(),
        {},
      ),
    ).rejects.toMatchObject({ statusCode: 404 });

    // Exists but is a tutor, not a student — opaque 404 (don't leak
    // existence of users in other roles).
    const otherTutor = await createUser(org._id, { role: "tutor" });
    await expect(
      listTeacherAuditLogService(
        teacher._id.toString(),
        otherTutor._id.toString(),
        {},
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("T4 — sorted by timestamp desc", async () => {
    const org = await createOrg();
    const teacher = await createUser(org._id, { role: "tutor" });
    const learner = await createUser(org._id, {
      assigned_teacher_id: teacher._id,
    });
    await seedAudit({
      orgId: org._id,
      learnerId: learner._id,
      reason: "oldest",
      timestamp: new Date("2026-01-01T10:00:00Z"),
    });
    await seedAudit({
      orgId: org._id,
      learnerId: learner._id,
      reason: "newest",
      timestamp: new Date("2026-03-01T10:00:00Z"),
    });
    await seedAudit({
      orgId: org._id,
      learnerId: learner._id,
      reason: "middle",
      timestamp: new Date("2026-02-01T10:00:00Z"),
    });

    const res = await listTeacherAuditLogService(
      teacher._id.toString(),
      learner._id.toString(),
      {},
    );
    const rows = (res.data as { rows: Array<{ reason: string }> }).rows;
    expect(rows.map((r) => r.reason)).toEqual(["newest", "middle", "oldest"]);
  });

  it("T5 — org-scope defence: rows on the same learner_id but a different org_id are excluded", async () => {
    // The learner_id ought to be unique cross-org in practice. This
    // test guards the defence-in-depth org_id pin: a malicious or
    // buggy writer that put a learner_id on a row in a different
    // org_id MUST not surface in the teacher's audit-log read.
    const orgA = await createOrg("A");
    const orgB = await createOrg("B");
    const teacher = await createUser(orgA._id, { role: "tutor" });
    const learner = await createUser(orgA._id, {
      assigned_teacher_id: teacher._id,
    });

    await seedAudit({
      orgId: orgA._id,
      learnerId: learner._id,
      reason: "same-org",
    });
    // Cross-org row pinned to the SAME learner_id (defence target).
    await seedAudit({
      orgId: orgB._id,
      learnerId: learner._id,
      reason: "cross-org",
    });

    const res = await listTeacherAuditLogService(
      teacher._id.toString(),
      learner._id.toString(),
      {},
    );
    const rows = (res.data as { rows: Array<{ reason: string }> }).rows;
    expect(rows.map((r) => r.reason)).toEqual(["same-org"]);
  });

  it("T6 — action + date filters narrow the result set", async () => {
    const org = await createOrg();
    const teacher = await createUser(org._id, { role: "tutor" });
    const learner = await createUser(org._id, {
      assigned_teacher_id: teacher._id,
    });
    await seedAudit({
      orgId: org._id,
      learnerId: learner._id,
      action: "session_completed",
      reason: "jan session",
      timestamp: new Date("2026-01-15T10:00:00Z"),
    });
    await seedAudit({
      orgId: org._id,
      learnerId: learner._id,
      action: "session_completed",
      reason: "feb session",
      timestamp: new Date("2026-02-15T10:00:00Z"),
    });
    await seedAudit({
      orgId: org._id,
      learnerId: learner._id,
      action: "mis_push_completed",
      reason: "feb mis",
      timestamp: new Date("2026-02-20T10:00:00Z"),
    });

    const res = await listTeacherAuditLogService(
      teacher._id.toString(),
      learner._id.toString(),
      { action: "session_completed", from: "2026-02-01", to: "2026-02-28" },
    );
    const rows = (res.data as { rows: Array<{ reason: string }> }).rows;
    expect(rows.map((r) => r.reason)).toEqual(["feb session"]);
  });

  it("T7 — reason field returned verbatim", async () => {
    const org = await createOrg();
    const teacher = await createUser(org._id, { role: "tutor" });
    const learner = await createUser(org._id, {
      assigned_teacher_id: teacher._id,
    });
    const inspectorCopy =
      "Pathway override extended for 30 days because learner reported family bereavement.";
    await seedAudit({
      orgId: org._id,
      learnerId: learner._id,
      reason: inspectorCopy,
    });
    const res = await listTeacherAuditLogService(
      teacher._id.toString(),
      learner._id.toString(),
      {},
    );
    const rows = (res.data as { rows: Array<{ reason: string }> }).rows;
    expect(rows[0].reason).toBe(inspectorCopy);
  });
});
