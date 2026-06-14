import ApiError from "../errors/apiError";
import ApiResponse from "../errors/apiResponse";
import User from "../models/User";
import {
  sendEsolTeacherApprovalMail,
  sendEsolTeacherRejectionMail,
} from "./nodemailer/mail.service";
import logger from "../config/logger";

const DASHBOARD_URL = process.env.DOMAIN_NAME
  ? `${process.env.DOMAIN_NAME}/tutor/esol`
  : "https://app.ambertraining.co.uk/tutor/esol";

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

  const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

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

  const query: any =
    conditions.length > 1 ? { $and: conditions } : conditions[0];

  const [teachers, total] = await Promise.all([
    User.find(query)
      .select(
        "firstname lastname email esolTeacherApproved esolQualificationType esolQualificationUrl dbsCheckStatus esolTeacherNotes averageRating totalLessons verified createdAt",
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

/* ── Apply for ESOL Teacher status (brief §2 Change 2) ──────────────
   Tutor self-service. Writes qualification + DBS reference + experience
   onto their user record and flips dbsCheckStatus to "pending" so admin
   knows it's awaiting review. Does NOT set esolTeacherApproved — that's
   the admin's call after reviewing the application.
─────────────────────────────────────────────────────────────────── */

export const applyEsolTeacherService = async (
  tutorId: string,
  data: {
    qualification_type: string;
    qualification_document_url: string;
    dbs_check_reference: string;
    esol_experience_description: string;
  },
) => {
  const tutor = await User.findOne({ _id: tutorId, role: "tutor" });
  if (!tutor) {
    throw new ApiError(404, "Tutor not found");
  }

  if (tutor.esolTeacherApproved === true) {
    throw new ApiError(
      400,
      "You are already approved as an ESOL teacher. Update your qualifications via the dashboard instead.",
    );
  }

  const updated = await User.findByIdAndUpdate(
    tutorId,
    {
      esolQualificationType: data.qualification_type,
      esolQualificationUrl: data.qualification_document_url,
      dbs_check_reference: data.dbs_check_reference,
      esol_experience_description: data.esol_experience_description,
      dbsCheckStatus: "pending",
      esol_application_submitted_at: new Date(),
      // Clear any prior rejection so admin sees this as a fresh application.
      esol_rejection_reason: null,
      esol_rejected_at: null,
    },
    { new: true, runValidators: true },
  ).select(
    "firstname lastname email esolQualificationType esolQualificationUrl dbsCheckStatus esol_experience_description esol_application_submitted_at",
  );

  return new ApiResponse(
    201,
    "ESOL teacher application submitted — Amber admin will review and email you the outcome",
    updated!.toJSON(),
  );
};

/* ── Approve Teacher for ESOL ──────────────────────────────────────
   Updated for brief §2 Change 2:
   - Reads stored application fields by default (no need to re-submit
     qualification on approval).
   - Sets dbsCheckStatus to "cleared" per brief.
   - Sends the approval email to the teacher.
   - Optional admin override fields preserved for back-compat with
     existing POST /api/esol/teachers/:tutorId/approve callers.
─────────────────────────────────────────────────────────────────── */

export const approveTeacherService = async (
  tutorId: string,
  data: {
    esolQualificationType?: string;
    esolQualificationUrl?: string;
    dbsCheckStatus?: string;
    esolTeacherNotes?: string;
  } = {},
) => {
  const tutor = await User.findOne({ _id: tutorId, role: "tutor" });
  if (!tutor) {
    throw new ApiError(404, "Tutor not found");
  }

  if (tutor.esolTeacherApproved === true) {
    throw new ApiError(400, "This tutor is already approved for ESOL");
  }

  // Resolve qualification fields: prefer admin overrides, fall back to
  // what the tutor submitted in their application.
  const qualificationType =
    data.esolQualificationType ?? tutor.esolQualificationType ?? null;
  if (!qualificationType) {
    throw new ApiError(
      400,
      "Tutor has not submitted an ESOL application yet — qualification type unknown. Ask them to apply via /api/esol/teachers/apply first.",
    );
  }

  const qualificationUrl =
    data.esolQualificationUrl ?? tutor.esolQualificationUrl ?? null;

  const updated = await User.findByIdAndUpdate(
    tutorId,
    {
      esolTeacherApproved: true,
      esolQualificationType: qualificationType,
      esolQualificationUrl: qualificationUrl,
      // Brief mandates dbsCheckStatus: "cleared" on approval.
      dbsCheckStatus: data.dbsCheckStatus ?? "cleared",
      esolTeacherNotes: data.esolTeacherNotes ?? tutor.esolTeacherNotes ?? null,
      // Clear any prior rejection state so the record is unambiguous.
      esol_rejection_reason: null,
      esol_rejected_at: null,
    },
    { new: true, runValidators: true },
  ).select(
    "firstname lastname email esolTeacherApproved esolQualificationType esolQualificationUrl dbsCheckStatus esolTeacherNotes",
  );

  // Fire-and-forget email. Failure to email must not roll back the approval.
  sendEsolTeacherApprovalMail({
    toEmail: tutor.email,
    teacherName: `${tutor.firstname} ${tutor.lastname}`,
    qualificationType: String(qualificationType),
    dashboardUrl: DASHBOARD_URL,
    notes: data.esolTeacherNotes ?? null,
  }).catch((err) =>
    logger.error({ err, tutorId }, "ESOL approval email failed"),
  );

  return new ApiResponse(
    200,
    "Teacher approved for ESOL successfully",
    updated!.toJSON(),
  );
};

/* ── Reject ESOL Teacher application (brief §2 Change 2) ────────────
   Stores the rejection reason on the user record (audit) and emails
   the teacher with that exact reason. Does NOT delete the application
   fields — the teacher may want to see what they previously submitted
   when they re-apply. The reason is also shown back to them in their UI.
─────────────────────────────────────────────────────────────────── */

export const rejectEsolTeacherService = async (
  tutorId: string,
  reason: string,
) => {
  const tutor = await User.findOne({ _id: tutorId, role: "tutor" });
  if (!tutor) {
    throw new ApiError(404, "Tutor not found");
  }

  if (tutor.esolTeacherApproved === true) {
    throw new ApiError(
      400,
      "This tutor is already approved. Use revokeTeacherApproval to remove ESOL access.",
    );
  }

  const updated = await User.findByIdAndUpdate(
    tutorId,
    {
      esolTeacherApproved: false,
      esol_rejection_reason: reason,
      esol_rejected_at: new Date(),
    },
    { new: true, runValidators: true },
  ).select(
    "firstname lastname email esolTeacherApproved esol_rejection_reason esol_rejected_at",
  );

  sendEsolTeacherRejectionMail({
    toEmail: tutor.email,
    teacherName: `${tutor.firstname} ${tutor.lastname}`,
    reason,
  }).catch((err) =>
    logger.error({ err, tutorId }, "ESOL rejection email failed"),
  );

  return new ApiResponse(
    200,
    "ESOL teacher application rejected",
    updated!.toJSON(),
  );
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
  },
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
    "firstname lastname email esolTeacherApproved esolQualificationType esolQualificationUrl dbsCheckStatus esolTeacherNotes",
  );

  return new ApiResponse(
    200,
    "Qualifications updated successfully",
    updated!.toJSON(),
  );
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
    { new: true },
  ).select("firstname lastname email esolTeacherApproved");

  return new ApiResponse(
    200,
    "ESOL approval revoked successfully",
    updated!.toJSON(),
  );
};
