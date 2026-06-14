/**
 * Tests for the teacher-assignment service — brief Final Addendum §4.
 *
 *   List
 *   ────
 *   L1   Returns approved + same-org + in assigned_teacher_ids only
 *   L2   Per-teacher learner counts come from User.assigned_teacher_id
 *   L3   `near_capacity` true at exactly 80%
 *   L4   Empty assigned_teacher_ids → empty list
 *
 *   Add
 *   ────
 *   AD1  Idempotent — adding twice doesn't duplicate
 *   AD2  Teacher must be esolTeacherApproved (else 400)
 *   AD3  Teacher must belong to the same org (else 403)
 *   AD4  Non-tutor target → 400
 *   AD5  Warning fires when count >= 80% of cap
 *
 *   Remove
 *   ──────
 *   RM1  Removes from org.assigned_teacher_ids
 *   RM2  Cascades — every assigned learner gets assigned_teacher_id = null
 *   RM3  Returns the unassigned count
 *
 *   Assign learner→teacher
 *   ──────────────────────
 *   AL1  Sets User.assigned_teacher_id; audit row written
 *   AL2  Teacher must be in org.assigned_teacher_ids (else 400)
 *   AL3  Cross-org learner → 403
 *   AL4  teacher_id null → explicit unassign path; success
 *   AL5  Warning fires when post-assign count >= 80% of cap
 */

process.env.REFERRAL_JWT_SECRET =
  process.env.REFERRAL_JWT_SECRET ?? "test-secret";

import { Types } from "mongoose";
import Organisation from "../models/Organisation";
import User from "../models/User";
import AuditLog from "../models/AuditLog";
import {
  listOrgTeachersService,
  addTeacherToOrgService,
  removeTeacherFromOrgService,
  assignTeacherToLearnerService,
} from "../services/teacherAssignment.service";

// ─────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────

const createOrg = async (
  opts: { name?: string; cap?: number; teacherIds?: unknown[] } = {},
) =>
  Organisation.create({
    name: opts.name ?? "TA Org",
    slug: `ta-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    contactEmail: "admin@ta.local",
    adminUserId: new Types.ObjectId(),
    billing_active: true,
    isActive: true,
    assigned_teacher_ids: opts.teacherIds ?? [],
    max_learners_per_teacher: opts.cap ?? 150,
  });

interface TeacherOpts {
  orgId: unknown;
  firstname?: string;
  lastname?: string;
  approved?: boolean;
}
const createTeacher = async (opts: TeacherOpts) =>
  User.create({
    firstname: opts.firstname ?? "T",
    lastname: opts.lastname ?? "Tutor",
    email: `tutor-${Date.now()}-${Math.random().toString(16).slice(2)}@ta.local`,
    password: "x",
    phoneNumber: "07000000099",
    role: "tutor",
    orgId: opts.orgId,
    isActive: true,
    status: "active",
    verified: true,
    esolTeacherApproved: opts.approved ?? true,
  });

interface LearnerOpts {
  orgId: unknown;
  assignedTeacherId?: unknown;
}
const createLearner = async (opts: LearnerOpts) =>
  User.create({
    firstname: "L",
    lastname: "Learner",
    email: `learner-${Date.now()}-${Math.random().toString(16).slice(2)}@ta.local`,
    password: "x",
    phoneNumber: "07000000000",
    role: "student",
    orgId: opts.orgId,
    isActive: true,
    status: "active",
    verified: true,
    esolLevel: "e2",
    assigned_teacher_id: opts.assignedTeacherId ?? null,
  });

const createOrgAdmin = async (orgId: unknown) =>
  User.create({
    firstname: "Org",
    lastname: "Admin",
    email: `oa-${Date.now()}-${Math.random().toString(16).slice(2)}@ta.local`,
    password: "x",
    phoneNumber: "07000000001",
    role: "org_admin",
    orgId,
    isActive: true,
    status: "active",
    verified: true,
  });

// ═════════════════════════════════════════════════════════════════════
// L1–L4 — listOrgTeachersService
// ═════════════════════════════════════════════════════════════════════

describe("listOrgTeachersService", () => {
  it("L1 — approved + in org + in assigned_teacher_ids only", async () => {
    // Setup: one teacher who satisfies all 3 conditions; three
    // distractors who fail one each.
    const orgA = await createOrg({ name: "A" });
    const orgB = await createOrg({ name: "B" });

    const ok = await createTeacher({ orgId: orgA._id, lastname: "Approved" });
    const notApproved = await createTeacher({
      orgId: orgA._id,
      lastname: "NotApproved",
      approved: false,
    });
    const otherOrg = await createTeacher({
      orgId: orgB._id,
      lastname: "OtherOrg",
    });
    const notInOrgList = await createTeacher({
      orgId: orgA._id,
      lastname: "NotInOrgList",
    });

    // Only OK + notApproved + notInOrgList are in orgA's assigned list,
    // but only OK satisfies ALL three conditions.
    await Organisation.updateOne(
      { _id: orgA._id },
      {
        $set: { assigned_teacher_ids: [ok._id, notApproved._id, otherOrg._id] },
      },
    );
    // notInOrgList is in orgA but NOT in assigned_teacher_ids
    expect(notInOrgList).toBeTruthy();

    const res = await listOrgTeachersService(orgA._id.toString());
    const data = res.data as {
      teachers: Array<{ _id: string; lastname: string }>;
      max_learners_per_teacher: number;
    };
    expect(data.teachers).toHaveLength(1);
    expect(data.teachers[0].lastname).toBe("Approved");
    expect(data.max_learners_per_teacher).toBe(150);
  });

  it("L2 — learner counts reflect User.assigned_teacher_id", async () => {
    const teacher = await createTeacher({ orgId: new Types.ObjectId() });
    const org = await createOrg({ teacherIds: [teacher._id] });
    // Re-create teacher under the new org so the existence check passes.
    await User.updateOne(
      { _id: teacher._id as unknown as never },
      { $set: { orgId: org._id } },
    );

    for (let i = 0; i < 3; i++) {
      await createLearner({ orgId: org._id, assignedTeacherId: teacher._id });
    }
    // Distractor: a learner with no teacher assigned
    await createLearner({ orgId: org._id });

    const res = await listOrgTeachersService(org._id.toString());
    const data = res.data as {
      teachers: Array<{ assigned_learner_count: number; utilisation: number }>;
    };
    expect(data.teachers[0].assigned_learner_count).toBe(3);
    expect(data.teachers[0].utilisation).toBeCloseTo(3 / 150, 5);
  });

  it("L3 — near_capacity flips at exactly 80%", async () => {
    const teacher = await createTeacher({ orgId: new Types.ObjectId() });
    const cap = 10;
    const org = await createOrg({ cap, teacherIds: [teacher._id] });
    await User.updateOne(
      { _id: teacher._id as unknown as never },
      { $set: { orgId: org._id } },
    );

    // 7 learners → 70% → NOT near capacity
    for (let i = 0; i < 7; i++) {
      await createLearner({ orgId: org._id, assignedTeacherId: teacher._id });
    }
    let res = await listOrgTeachersService(org._id.toString());
    expect(
      (res.data as { teachers: Array<{ near_capacity: boolean }> }).teachers[0]
        .near_capacity,
    ).toBe(false);

    // Add one more → 80% → IS near capacity
    await createLearner({ orgId: org._id, assignedTeacherId: teacher._id });
    res = await listOrgTeachersService(org._id.toString());
    expect(
      (res.data as { teachers: Array<{ near_capacity: boolean }> }).teachers[0]
        .near_capacity,
    ).toBe(true);
  });

  it("L4 — empty assigned_teacher_ids returns empty list", async () => {
    const org = await createOrg();
    const res = await listOrgTeachersService(org._id.toString());
    expect((res.data as { teachers: Array<unknown> }).teachers).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════
// AD1–AD5 — addTeacherToOrgService
// ═════════════════════════════════════════════════════════════════════

describe("addTeacherToOrgService", () => {
  it("AD1 — idempotent: adding twice doesn't duplicate", async () => {
    const org = await createOrg();
    const teacher = await createTeacher({ orgId: org._id });
    const admin = await createOrgAdmin(org._id);

    await addTeacherToOrgService(
      org._id.toString(),
      teacher._id.toString(),
      admin._id.toString(),
    );
    await addTeacherToOrgService(
      org._id.toString(),
      teacher._id.toString(),
      admin._id.toString(),
    );

    const reloaded = await Organisation.findById(org._id).lean();
    const ids = (reloaded?.assigned_teacher_ids ?? []) as Types.ObjectId[];
    expect(ids).toHaveLength(1);
    expect(ids[0].toString()).toBe(teacher._id.toString());
  });

  it("AD2 — must be esolTeacherApproved", async () => {
    const org = await createOrg();
    const teacher = await createTeacher({ orgId: org._id, approved: false });
    const admin = await createOrgAdmin(org._id);

    await expect(
      addTeacherToOrgService(
        org._id.toString(),
        teacher._id.toString(),
        admin._id.toString(),
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("AD3 — teacher from a different org → 403", async () => {
    const orgMine = await createOrg();
    const orgOther = await createOrg();
    const teacherInOther = await createTeacher({ orgId: orgOther._id });
    const admin = await createOrgAdmin(orgMine._id);

    await expect(
      addTeacherToOrgService(
        orgMine._id.toString(),
        teacherInOther._id.toString(),
        admin._id.toString(),
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("AD4 — target is not a tutor → 400", async () => {
    const org = await createOrg();
    const learner = await createLearner({ orgId: org._id });
    const admin = await createOrgAdmin(org._id);

    await expect(
      addTeacherToOrgService(
        org._id.toString(),
        learner._id.toString(),
        admin._id.toString(),
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("AD5 — warning fires when current count >= 80% of cap", async () => {
    const cap = 10;
    const org = await createOrg({ cap });
    const teacher = await createTeacher({ orgId: org._id });
    const admin = await createOrgAdmin(org._id);

    // Seed 8 already-assigned learners (= 80%)
    for (let i = 0; i < 8; i++) {
      await createLearner({ orgId: org._id, assignedTeacherId: teacher._id });
    }

    const res = await addTeacherToOrgService(
      org._id.toString(),
      teacher._id.toString(),
      admin._id.toString(),
    );
    const data = res.data as {
      warning_flag: boolean;
      warning_message?: string;
    };
    expect(data.warning_flag).toBe(true);
    expect(data.warning_message).toMatch(/80%|cap/i);
  });
});

// ═════════════════════════════════════════════════════════════════════
// RM1–RM3 — removeTeacherFromOrgService
// ═════════════════════════════════════════════════════════════════════

describe("removeTeacherFromOrgService", () => {
  it("RM1+RM2+RM3 — removes from list, cascades, counts", async () => {
    const teacher = await createTeacher({ orgId: new Types.ObjectId() });
    const org = await createOrg({ teacherIds: [teacher._id] });
    await User.updateOne(
      { _id: teacher._id as unknown as never },
      { $set: { orgId: org._id } },
    );

    // 4 learners assigned to this teacher; 1 to nobody (distractor)
    for (let i = 0; i < 4; i++) {
      await createLearner({ orgId: org._id, assignedTeacherId: teacher._id });
    }
    await createLearner({ orgId: org._id });

    const admin = await createOrgAdmin(org._id);
    const res = await removeTeacherFromOrgService(
      org._id.toString(),
      teacher._id.toString(),
      admin._id.toString(),
    );

    // RM3 — count of unassigned
    expect(
      (res.data as { learners_unassigned: number }).learners_unassigned,
    ).toBe(4);

    // RM1 — teacher no longer in org.assigned_teacher_ids
    const reloadedOrg = await Organisation.findById(org._id).lean();
    expect(
      (reloadedOrg?.assigned_teacher_ids ?? []) as Types.ObjectId[],
    ).toHaveLength(0);

    // RM2 — every learner's assigned_teacher_id is now null
    const remaining = await User.countDocuments({
      orgId: org._id,
      assigned_teacher_id: teacher._id,
    });
    expect(remaining).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════════════
// AL1–AL5 — assignTeacherToLearnerService
// ═════════════════════════════════════════════════════════════════════

describe("assignTeacherToLearnerService", () => {
  it("AL1 — sets assigned_teacher_id; audit row written", async () => {
    const teacher = await createTeacher({ orgId: new Types.ObjectId() });
    const org = await createOrg({ teacherIds: [teacher._id] });
    await User.updateOne(
      { _id: teacher._id as unknown as never },
      { $set: { orgId: org._id } },
    );
    const learner = await createLearner({ orgId: org._id });
    const admin = await createOrgAdmin(org._id);

    const res = await assignTeacherToLearnerService(
      org._id.toString(),
      learner._id.toString(),
      { teacher_id: teacher._id.toString() },
      admin._id.toString(),
    );
    const data = res.data as {
      assigned_teacher_id: string;
      warning_flag: boolean;
    };
    expect(data.assigned_teacher_id).toBe(teacher._id.toString());
    expect(data.warning_flag).toBe(false);

    const reloaded = await User.findById(learner._id).lean();
    expect(reloaded?.assigned_teacher_id?.toString()).toBe(
      teacher._id.toString(),
    );

    const audit = await AuditLog.findOne({
      learner_id: learner._id,
      action: "learner_teacher_assigned",
    }).lean();
    expect(audit).toBeTruthy();
  });

  it("AL2 — teacher not in org's assigned_teacher_ids → 400", async () => {
    const org = await createOrg(); // empty assigned_teacher_ids
    const teacher = await createTeacher({ orgId: org._id });
    const learner = await createLearner({ orgId: org._id });
    const admin = await createOrgAdmin(org._id);

    await expect(
      assignTeacherToLearnerService(
        org._id.toString(),
        learner._id.toString(),
        { teacher_id: teacher._id.toString() },
        admin._id.toString(),
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("AL3 — cross-org learner → 403", async () => {
    const orgMine = await createOrg();
    const orgOther = await createOrg();
    const learnerInOther = await createLearner({ orgId: orgOther._id });
    const admin = await createOrgAdmin(orgMine._id);

    await expect(
      assignTeacherToLearnerService(
        orgMine._id.toString(),
        learnerInOther._id.toString(),
        { teacher_id: new Types.ObjectId().toString() },
        admin._id.toString(),
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("AL4 — teacher_id null is the explicit unassign path", async () => {
    const teacher = await createTeacher({ orgId: new Types.ObjectId() });
    const org = await createOrg({ teacherIds: [teacher._id] });
    await User.updateOne(
      { _id: teacher._id as unknown as never },
      { $set: { orgId: org._id } },
    );
    const learner = await createLearner({
      orgId: org._id,
      assignedTeacherId: teacher._id,
    });
    const admin = await createOrgAdmin(org._id);

    const res = await assignTeacherToLearnerService(
      org._id.toString(),
      learner._id.toString(),
      { teacher_id: null },
      admin._id.toString(),
    );
    expect(
      (res.data as { assigned_teacher_id: string | null }).assigned_teacher_id,
    ).toBeNull();

    const reloaded = await User.findById(learner._id).lean();
    expect(reloaded?.assigned_teacher_id).toBeNull();
  });

  it("AL5 — warning fires when post-assign count >= 80%", async () => {
    const cap = 10;
    const teacher = await createTeacher({ orgId: new Types.ObjectId() });
    const org = await createOrg({ cap, teacherIds: [teacher._id] });
    await User.updateOne(
      { _id: teacher._id as unknown as never },
      { $set: { orgId: org._id } },
    );

    // Pre-seed 7 learners assigned to this teacher
    for (let i = 0; i < 7; i++) {
      await createLearner({ orgId: org._id, assignedTeacherId: teacher._id });
    }
    // Now assign an 8th — should push to 80% and trigger warning
    const newLearner = await createLearner({ orgId: org._id });
    const admin = await createOrgAdmin(org._id);

    const res = await assignTeacherToLearnerService(
      org._id.toString(),
      newLearner._id.toString(),
      { teacher_id: teacher._id.toString() },
      admin._id.toString(),
    );
    const data = res.data as {
      warning_flag: boolean;
      assigned_learner_count: number;
    };
    expect(data.warning_flag).toBe(true);
    expect(data.assigned_learner_count).toBe(8);
  });
});
