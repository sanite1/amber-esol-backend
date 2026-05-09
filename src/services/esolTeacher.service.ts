import ApiError from "../errors/apiError";
import ApiResponse from "../errors/apiResponse";
import User from "../models/User";

/* ── List ESOL Teachers ── */

export const listEsolTeachersService = async (options: {
  page?: string;
  limit?: string;
  search?: string;
  approvedOnly?: string;
}) => {
  const page = parseInt(options.page || "1", 10);
  const limit = parseInt(options.limit || "20", 10);
  const skip = (page - 1) * limit;

  const escapeRegex = (s: string) =>
    s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const conditions: any[] = [{ role: "tutor" }, { isActive: true }];

  if (options.approvedOnly === "true") {
    conditions.push({ esolTeacherApproved: true });
  } else {
    // Default: show approved teachers and those pending approval
    conditions.push({
      $or: [
        { esolTeacherApproved: true },
        { dbsCheckStatus: { $in: ["pending", "clear"] } },
      ],
    });
  }

  if (options.search) {
    const regex = new RegExp(escapeRegex(options.search), "i");
    conditions.push({
      $or: [{ firstname: regex }, { lastname: regex }, { email: regex }],
    });
  }

  const query: any = conditions.length > 1 ? { $and: conditions } : conditions[0];

  const [teachers, total] = await Promise.all([
    User.find(query)
      .select(
        "firstname lastname email esolTeacherApproved esolQualificationType esolQualificationUrl dbsCheckStatus esolTeacherNotes averageRating totalLessons verified createdAt"
      )
      .sort({ esolTeacherApproved: -1, averageRating: -1 })
      .skip(skip)
      .limit(limit),
    User.countDocuments(query),
  ]);

  return new ApiResponse(200, "ESOL teachers retrieved successfully", {
    teachers,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
};

/* ── Approve Teacher for ESOL ── */

export const approveTeacherService = async (
  tutorId: string,
  data: {
    esolQualificationType: string;
    esolQualificationUrl?: string;
    dbsCheckStatus?: string;
    esolTeacherNotes?: string;
  }
) => {
  const tutor = await User.findOne({ _id: tutorId, role: "tutor" });
  if (!tutor) {
    throw new ApiError(404, "Tutor not found");
  }

  if (tutor.esolTeacherApproved) {
    throw new ApiError(400, "This tutor is already approved for ESOL");
  }

  const updated = await User.findByIdAndUpdate(
    tutorId,
    {
      esolTeacherApproved: true,
      esolQualificationType: data.esolQualificationType,
      esolQualificationUrl: data.esolQualificationUrl || null,
      dbsCheckStatus: data.dbsCheckStatus || "pending",
      esolTeacherNotes: data.esolTeacherNotes || null,
    },
    { new: true, runValidators: true }
  ).select(
    "firstname lastname email esolTeacherApproved esolQualificationType esolQualificationUrl dbsCheckStatus esolTeacherNotes"
  );

  return new ApiResponse(200, "Teacher approved for ESOL successfully", updated!.toJSON());
};

/* ── Update Teacher Qualifications ── */

export const updateTeacherQualificationsService = async (
  tutorId: string,
  callerId: string,
  callerRole: string,
  data: {
    esolQualificationType?: string;
    esolQualificationUrl?: string;
    dbsCheckStatus?: string;
    esolTeacherNotes?: string;
  }
) => {
  // Tutors can only update their own qualifications
  if (callerRole === "tutor" && callerId !== tutorId) {
    throw new ApiError(403, "You can only update your own qualifications");
  }

  const tutor = await User.findOne({ _id: tutorId, role: "tutor" });
  if (!tutor) {
    throw new ApiError(404, "Tutor not found");
  }

  const updated = await User.findByIdAndUpdate(tutorId, data, {
    new: true,
    runValidators: true,
  }).select(
    "firstname lastname email esolTeacherApproved esolQualificationType esolQualificationUrl dbsCheckStatus esolTeacherNotes"
  );

  return new ApiResponse(200, "Qualifications updated successfully", updated!.toJSON());
};

/* ── Revoke ESOL Approval ── */

export const revokeTeacherApprovalService = async (tutorId: string) => {
  const tutor = await User.findOne({ _id: tutorId, role: "tutor" });
  if (!tutor) {
    throw new ApiError(404, "Tutor not found");
  }

  if (!tutor.esolTeacherApproved) {
    throw new ApiError(400, "This tutor does not have ESOL approval");
  }

  const updated = await User.findByIdAndUpdate(
    tutorId,
    { esolTeacherApproved: false },
    { new: true }
  ).select("firstname lastname email esolTeacherApproved");

  return new ApiResponse(200, "ESOL approval revoked successfully", updated!.toJSON());
};
