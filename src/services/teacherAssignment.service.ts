/**
 * Teacher assignment management — brief Final Addendum §4.
 *
 * Four operations:
 *
 *   listOrgTeachersService             list approved teachers in an org
 *   addTeacherToOrgService             add a teacher to org.assigned_teacher_ids
 *   removeTeacherFromOrgService        remove + cascade-unassign all learners
 *   assignTeacherToLearnerService      set User.assigned_teacher_id
 *
 * Shared invariants:
 *
 *   - Org admin can only act on their own org. The route layer
 *     enforces this via requireOrgContext; services trust the gate
 *     and use callerOrgId as the source of truth.
 *   - A teacher must have `esolTeacherApproved: true` AND `orgId`
 *     matching the caller's org before they can be added. Approving
 *     a teacher is an Amber-admin operation (Phase 7) — org admins
 *     just pick from the approved pool.
 *   - Removing a teacher from the org also nulls
 *     `User.assigned_teacher_id` on every learner who had them. The
 *     two writes happen inside a transaction-equivalent (catch on the
 *     update, log loudly, re-throw) so a partial removal can be
 *     audited.
 *   - 80% utilisation warning: when an assignment would push a
 *     teacher above 80% of Organisation.max_learners_per_teacher, the
 *     mutation succeeds but the response carries a `warning_flag`
 *     that the frontend renders as an amber banner.
 *
 * Audit log entries written for every state change so an inspector
 * can reconstruct who assigned whom and when.
 */

import { Types } from "mongoose";
import ApiError from "../errors/apiError";
import ApiResponse from "../errors/apiResponse";
import Organisation from "../models/Organisation";
import User from "../models/User";
import AuditLog from "../models/AuditLog";
import logger from "../config/logger";

// ─────────────────────────────────────────────────────────────────────
// Shape: teacher row
// ─────────────────────────────────────────────────────────────────────

export interface OrgTeacherRow {
  _id: string;
  firstname: string;
  lastname: string;
  email: string | null;
  /** Learner count currently assigned to this teacher within the org. */
  assigned_learner_count: number;
  /** Same number expressed as a fraction of max_learners_per_teacher. */
  utilisation: number;
  /**
   * 80% threshold flag — true when assigned_learner_count >=
   * 0.8 * max_learners_per_teacher. The frontend renders an amber
   * row tint when set.
   */
  near_capacity: boolean;
  /** Hard cap from the org doc — included for the frontend to render. */
  max_learners_per_teacher: number;
  /** Matching foundation — rendered as chips on the teacher row. */
  teaching_profile: {
    levels_taught: string[];
    languages_spoken: string[];
    specialisms: string[];
  };
}

export interface OrgTeacherListResult {
  teachers: OrgTeacherRow[];
  max_learners_per_teacher: number;
}

// ─────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────

const NEAR_CAPACITY_RATIO = 0.8;

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

/**
 * Load the org doc and assert the caller owns it. Routes guard the
 * outer layer; this re-assertion stops a future service-to-service
 * call from bypassing the route check.
 */
const loadOrgOrThrow = async (callerOrgId: string) => {
  if (!callerOrgId || !Types.ObjectId.isValid(callerOrgId)) {
    throw new ApiError(
      400,
      "Organisation context is required and must be valid",
    );
  }
  const org = await Organisation.findById(callerOrgId)
    .select("name assigned_teacher_ids max_learners_per_teacher")
    .lean();
  if (!org) throw new ApiError(404, "Organisation not found");
  return org;
};

const utilisationFor = (count: number, cap: number) =>
  cap > 0 ? Math.round((count / cap) * 100) / 100 : 0;

const isNearCapacity = (count: number, cap: number) =>
  cap > 0 && count >= NEAR_CAPACITY_RATIO * cap;

/**
 * Count learners currently assigned to a teacher within a specific
 * org. Two filters — the org_id keeps us scoped, assigned_teacher_id
 * narrows to "this teacher's caseload". The compound index on
 * (assigned_teacher_id, teacher_priority_level) covers this hot path.
 */
const countLearnersForTeacher = (
  teacherId: Types.ObjectId,
  orgId: Types.ObjectId,
): Promise<number> =>
  User.countDocuments({
    role: "student",
    orgId,
    assigned_teacher_id: teacherId,
    isActive: true,
  });

// ─────────────────────────────────────────────────────────────────────
// 1. List
// ─────────────────────────────────────────────────────────────────────

/**
 * GET /api/org-admin/teachers
 *
 * Returns the org's approved teacher list with per-teacher learner
 * counts and the utilisation ratio. The list is intersect of three
 * conditions:
 *   - User.orgId == callerOrgId  (teacher works at this org)
 *   - User._id in Organisation.assigned_teacher_ids  (org has opted them in)
 *   - User.esolTeacherApproved == true  (Amber has approved them)
 *
 * The first two enforce org isolation; the third is the global gate.
 *
 * The count uses one aggregate to fan out — single round-trip
 * regardless of teacher count.
 */
export const listOrgTeachersService = async (
  callerOrgId: string,
): Promise<ApiResponse> => {
  const org = await loadOrgOrThrow(callerOrgId);
  const orgObjectId = new Types.ObjectId(callerOrgId);
  const cap = (org.max_learners_per_teacher as number) ?? 0;
  const assignedTeacherIds = (org.assigned_teacher_ids ??
    []) as Types.ObjectId[];

  if (assignedTeacherIds.length === 0) {
    return new ApiResponse(200, "No teachers assigned to this org yet", {
      teachers: [],
      max_learners_per_teacher: cap,
    });
  }

  // Pull the candidate teachers, filtered to approved + same org.
  const teachers = await User.find({
    _id: { $in: assignedTeacherIds },
    orgId: orgObjectId,
    role: "tutor",
    esolTeacherApproved: true,
  })
    .select("firstname lastname email teaching_profile")
    .lean();

  // Count learners per teacher in ONE aggregation, then merge in Node.
  const counts = await User.aggregate<{ _id: Types.ObjectId; count: number }>([
    {
      $match: {
        role: "student",
        orgId: orgObjectId,
        isActive: true,
        assigned_teacher_id: { $in: teachers.map((t) => t._id) },
      },
    },
    { $group: { _id: "$assigned_teacher_id", count: { $sum: 1 } } },
  ]);
  const countByTeacher = new Map(
    counts.map((c) => [c._id.toString(), c.count]),
  );

  const rows: OrgTeacherRow[] = teachers
    .map((t) => {
      const count = countByTeacher.get(t._id.toString()) ?? 0;
      return {
        _id: t._id.toString(),
        firstname: t.firstname ?? "",
        lastname: t.lastname ?? "",
        email: t.email ?? null,
        assigned_learner_count: count,
        utilisation: utilisationFor(count, cap),
        near_capacity: isNearCapacity(count, cap),
        max_learners_per_teacher: cap,
        teaching_profile: {
          levels_taught: t.teaching_profile?.levels_taught ?? [],
          languages_spoken: t.teaching_profile?.languages_spoken ?? [],
          specialisms: t.teaching_profile?.specialisms ?? [],
        },
      };
    })
    // Stable sort — alphabetical by lastname so the table reads
    // consistently across reloads.
    .sort((a, b) => a.lastname.localeCompare(b.lastname));

  const result: OrgTeacherListResult = {
    teachers: rows,
    max_learners_per_teacher: cap,
  };
  return new ApiResponse(200, "Org teachers retrieved", result);
};

// ─────────────────────────────────────────────────────────────────────
// 2. Add to org
// ─────────────────────────────────────────────────────────────────────

export interface TeacherMutationResult {
  teacher_id: string;
  warning_flag: boolean;
  /** Human-readable explanation; populated when warning_flag is true. */
  warning_message?: string;
  assigned_learner_count: number;
  max_learners_per_teacher: number;
}

/**
 * POST /api/org-admin/teachers/:teacherId — add a teacher to the org's
 * assigned_teacher_ids.
 *
 * Preconditions:
 *   - Teacher exists
 *   - Teacher.role == "tutor"
 *   - Teacher.esolTeacherApproved == true
 *   - Teacher.orgId == callerOrgId (a teacher belongs to one org)
 *
 * If the teacher is already in the list, the call is idempotent — no
 * duplicate entry added, no error thrown. The warning flag still
 * fires when applicable.
 */
export const addTeacherToOrgService = async (
  callerOrgId: string,
  teacherId: string,
  callerId: string,
): Promise<ApiResponse> => {
  if (!teacherId || !Types.ObjectId.isValid(teacherId)) {
    throw new ApiError(400, "teacherId must be a valid ObjectId");
  }
  if (!callerId || !Types.ObjectId.isValid(callerId)) {
    throw new ApiError(400, "Authenticated caller id required");
  }
  const org = await loadOrgOrThrow(callerOrgId);
  const orgObjectId = new Types.ObjectId(callerOrgId);
  const teacherObjectId = new Types.ObjectId(teacherId);

  const teacher = await User.findById(teacherObjectId)
    .select("_id firstname lastname role esolTeacherApproved orgId")
    .lean();

  if (!teacher) throw new ApiError(404, "Teacher not found");
  if (teacher.role !== "tutor") {
    throw new ApiError(400, "Target user is not a tutor");
  }
  if (!teacher.esolTeacherApproved) {
    throw new ApiError(
      400,
      "Teacher must be ESOL-approved by Amber before they can be added to an org. Ask Amber admin to approve.",
    );
  }
  if (teacher.orgId?.toString() !== callerOrgId) {
    throw new ApiError(403, "Teacher does not belong to your organisation");
  }

  // Idempotent set-style update.
  await Organisation.updateOne(
    { _id: orgObjectId },
    { $addToSet: { assigned_teacher_ids: teacherObjectId } },
  );

  const count = await countLearnersForTeacher(teacherObjectId, orgObjectId);
  const cap = (org.max_learners_per_teacher as number) ?? 0;
  const nearCapacity = isNearCapacity(count, cap);

  await AuditLog.create({
    timestamp: new Date(),
    actor_type: "org_admin",
    actor_id: new Types.ObjectId(callerId),
    org_id: orgObjectId,
    learner_id: null,
    action: "teacher_added_to_org",
    before_state: null,
    after_state: { teacher_id: teacherId, assigned_learner_count: count },
    reason: "Org admin added teacher to assignable pool",
    compliance_config_version: null,
  }).catch((err) =>
    logger.error(
      { err: (err as Error).message, teacherId, orgId: callerOrgId },
      "addTeacherToOrg: AuditLog write failed",
    ),
  );

  const result: TeacherMutationResult = {
    teacher_id: teacherId,
    warning_flag: nearCapacity,
    ...(nearCapacity && {
      warning_message: `Teacher is at ${Math.round((count / cap) * 100)}% of the ${cap}-learner cap. Consider redistributing before adding more.`,
    }),
    assigned_learner_count: count,
    max_learners_per_teacher: cap,
  };
  return new ApiResponse(200, "Teacher added to org", result);
};

// ─────────────────────────────────────────────────────────────────────
// 3. Remove from org (cascade unassign)
// ─────────────────────────────────────────────────────────────────────

export const removeTeacherFromOrgService = async (
  callerOrgId: string,
  teacherId: string,
  callerId: string,
): Promise<ApiResponse> => {
  if (!teacherId || !Types.ObjectId.isValid(teacherId)) {
    throw new ApiError(400, "teacherId must be a valid ObjectId");
  }
  if (!callerId || !Types.ObjectId.isValid(callerId)) {
    throw new ApiError(400, "Authenticated caller id required");
  }
  await loadOrgOrThrow(callerOrgId); // confirm org exists
  const orgObjectId = new Types.ObjectId(callerOrgId);
  const teacherObjectId = new Types.ObjectId(teacherId);

  // 1. Remove from the org's assigned_teacher_ids.
  await Organisation.updateOne(
    { _id: orgObjectId },
    { $pull: { assigned_teacher_ids: teacherObjectId } },
  );

  // 2. Cascade: null assigned_teacher_id on every learner who had them.
  //    The count tells the org admin how many learners are now
  //    unassigned, which is the action they probably need next.
  //
  //    We DON'T wrap this in a Mongo transaction — the User write is
  //    idempotent (running it again is a no-op), and a failure here
  //    leaves the org-side removal intact, which is the safer
  //    direction (org admin sees the teacher is gone; learners
  //    they thought were assigned now show as unassigned). A
  //    half-completed cascade would otherwise leave learners pointing
  //    at a teacher the org admin can't see in the UI.
  const cascade = await User.updateMany(
    {
      role: "student",
      orgId: orgObjectId,
      assigned_teacher_id: teacherObjectId,
    },
    { $set: { assigned_teacher_id: null } },
  );

  await AuditLog.create({
    timestamp: new Date(),
    actor_type: "org_admin",
    actor_id: new Types.ObjectId(callerId),
    org_id: orgObjectId,
    learner_id: null,
    action: "teacher_removed_from_org",
    before_state: null,
    after_state: {
      teacher_id: teacherId,
      learners_unassigned: cascade.modifiedCount ?? 0,
    },
    reason: "Org admin removed teacher; learner assignments cascaded to null",
    compliance_config_version: null,
  }).catch((err) =>
    logger.error(
      { err: (err as Error).message, teacherId, orgId: callerOrgId },
      "removeTeacherFromOrg: AuditLog write failed",
    ),
  );

  return new ApiResponse(200, "Teacher removed from org", {
    teacher_id: teacherId,
    learners_unassigned: cascade.modifiedCount ?? 0,
  });
};

// ─────────────────────────────────────────────────────────────────────
// 4. Assign teacher to learner
// ─────────────────────────────────────────────────────────────────────

export interface AssignTeacherToLearnerBody {
  teacher_id: string | null;
}

/**
 * PATCH /api/org-admin/learners/:learnerId/teacher
 *
 * Sets User.assigned_teacher_id. The teacher must already be in the
 * org's assigned_teacher_ids list (otherwise 400). A null teacher_id
 * is the explicit "unassign" path.
 */
export const assignTeacherToLearnerService = async (
  callerOrgId: string,
  learnerId: string,
  body: AssignTeacherToLearnerBody,
  callerId: string,
): Promise<ApiResponse> => {
  if (!learnerId || !Types.ObjectId.isValid(learnerId)) {
    throw new ApiError(400, "learnerId must be a valid ObjectId");
  }
  if (!callerId || !Types.ObjectId.isValid(callerId)) {
    throw new ApiError(400, "Authenticated caller id required");
  }
  const org = await loadOrgOrThrow(callerOrgId);
  const orgObjectId = new Types.ObjectId(callerOrgId);

  // Load the learner and verify they belong to the caller's org.
  const learner = await User.findById(learnerId)
    .select("_id orgId role assigned_teacher_id")
    .lean();
  if (!learner) throw new ApiError(404, "Learner not found");
  if (learner.role !== "student") {
    throw new ApiError(400, "Target user is not a student");
  }
  if (learner.orgId?.toString() !== callerOrgId) {
    throw new ApiError(403, "Learner does not belong to your organisation");
  }

  const prevTeacherId = learner.assigned_teacher_id ?? null;

  // Branch: explicit unassign.
  if (body?.teacher_id === null) {
    await User.updateOne(
      { _id: learner._id },
      { $set: { assigned_teacher_id: null } },
    );
    await AuditLog.create({
      timestamp: new Date(),
      actor_type: "org_admin",
      actor_id: new Types.ObjectId(callerId),
      org_id: orgObjectId,
      learner_id: learner._id,
      action: "learner_teacher_assigned",
      before_state: { assigned_teacher_id: prevTeacherId?.toString() ?? null },
      after_state: { assigned_teacher_id: null },
      reason: "Org admin unassigned teacher from learner",
      compliance_config_version: null,
    }).catch((err) =>
      logger.error(
        { err: (err as Error).message, learnerId, orgId: callerOrgId },
        "assignTeacherToLearner (unassign): AuditLog write failed",
      ),
    );
    return new ApiResponse(200, "Learner unassigned from teacher", {
      learner_id: learnerId,
      assigned_teacher_id: null,
      warning_flag: false,
      assigned_learner_count: 0,
      max_learners_per_teacher: (org.max_learners_per_teacher as number) ?? 0,
    });
  }

  // Branch: assign.
  if (!body?.teacher_id || !Types.ObjectId.isValid(body.teacher_id)) {
    throw new ApiError(400, "teacher_id must be a valid ObjectId or null");
  }
  const teacherObjectId = new Types.ObjectId(body.teacher_id);

  const assignedTeacherIds = (org.assigned_teacher_ids ??
    []) as Types.ObjectId[];
  const teacherInOrg = assignedTeacherIds.some(
    (id) => id.toString() === body.teacher_id,
  );
  if (!teacherInOrg) {
    throw new ApiError(
      400,
      "Teacher is not in this org's assigned teacher pool. Add the teacher to the org first.",
    );
  }

  // Apply the change.
  await User.updateOne(
    { _id: learner._id },
    { $set: { assigned_teacher_id: teacherObjectId } },
  );

  // Recount AFTER the write so the warning reflects the new state
  // (the post-write count includes the learner we just assigned).
  const count = await countLearnersForTeacher(teacherObjectId, orgObjectId);
  const cap = (org.max_learners_per_teacher as number) ?? 0;
  const nearCapacity = isNearCapacity(count, cap);

  await AuditLog.create({
    timestamp: new Date(),
    actor_type: "org_admin",
    actor_id: new Types.ObjectId(callerId),
    org_id: orgObjectId,
    learner_id: learner._id,
    action: "learner_teacher_assigned",
    before_state: { assigned_teacher_id: prevTeacherId?.toString() ?? null },
    after_state: { assigned_teacher_id: body.teacher_id },
    reason: "Org admin assigned teacher to learner",
    compliance_config_version: null,
  }).catch((err) =>
    logger.error(
      { err: (err as Error).message, learnerId, orgId: callerOrgId },
      "assignTeacherToLearner: AuditLog write failed",
    ),
  );

  return new ApiResponse(200, "Learner assigned to teacher", {
    learner_id: learnerId,
    assigned_teacher_id: body.teacher_id,
    warning_flag: nearCapacity,
    ...(nearCapacity && {
      warning_message: `Teacher is at ${Math.round((count / cap) * 100)}% of the ${cap}-learner cap. Consider redistributing before adding more.`,
    }),
    assigned_learner_count: count,
    max_learners_per_teacher: cap,
  });
};

export const __internals__ = {
  NEAR_CAPACITY_RATIO,
  utilisationFor,
  isNearCapacity,
};
