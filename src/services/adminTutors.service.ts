import ApiError from "../errors/apiError";
import ApiResponse from "../errors/apiResponse";
import User from "../models/User";
import Booking from "../models/Booking";
import Wallet from "../models/Wallet";
import Review from "../models/Review";
import {
  IAdminTutorsQuery,
  IAdminUpdateTutorStatusRequest,
} from "../interfaces/adminTutors.interface";
import { createNotification } from "./notification.service";

/* ══════════════════════════════════════════════
   GET ADMIN TUTORS (list + stats)
   ══════════════════════════════════════════════ */

export const getAdminTutorsService = async (query: IAdminTutorsQuery) => {
  const page = parseInt(query.page || "1", 10);
  const limit = parseInt(query.limit || "10", 10);
  const skip = (page - 1) * limit;

  /* ── Base filter ── */
  const filter: any = { role: "tutor" };

  /* ── Status filter ── */
  if (query.status && query.status !== "all") {
    switch (query.status) {
      case "active":
        filter.isActive = true;
        filter.status = "active";
        break;
      case "inactive":
        // Tutors who were once active but went inactive
        filter.isActive = true;
        filter.status = "active";
        filter.lastLogin = {
          $lt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
        };
        break;
      case "pending_approval":
        filter.status = "unverified";
        break;
      case "rejected":
        filter.status = "terminated";
        break;
      case "banned":
        filter.isActive = false;
        filter.status = "suspended";
        break;
    }
  }

  /* ── Search ── */
  if (query.search && query.search.trim()) {
    const q = new RegExp(query.search.trim(), "i");
    filter.$or = [
      { firstname: q },
      { lastname: q },
      { email: q },
      { "address.country": q },
      { "address.city": q },
      { specializations: q },
    ];
  }

  /* ── Sort ── */
  let sortOption: any = { createdAt: -1 };
  const needsExternalSort = query.sort === "earned";

  switch (query.sort) {
    case "name":
      sortOption = { firstname: 1, lastname: 1 };
      break;
    case "rating":
      sortOption = { averageRating: -1 };
      break;
    case "lessons":
      sortOption = { totalLessons: -1 };
      break;
    case "students":
      sortOption = { totalStudents: -1 };
      break;
    case "earned":
      // Will sort after enrichment
      break;
    default:
      sortOption = { createdAt: -1 };
  }

  /* ── Stats (parallel) ── */
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const [
    total,
    activeCount,
    inactiveCount,
    pendingApproval,
    rejectedCount,
    bannedCount,
    newThisMonth,
  ] = await Promise.all([
    User.countDocuments({ role: "tutor" }),
    User.countDocuments({
      role: "tutor",
      isActive: true,
      status: "active",
    }),
    User.countDocuments({
      role: "tutor",
      isActive: true,
      status: "active",
      lastLogin: { $lt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
    }),
    User.countDocuments({ role: "tutor", status: "unverified" }),
    User.countDocuments({ role: "tutor", status: "terminated" }),
    User.countDocuments({
      role: "tutor",
      isActive: false,
      status: "suspended",
    }),
    User.countDocuments({
      role: "tutor",
      createdAt: { $gte: startOfMonth },
    }),
  ]);

  const stats = {
    total,
    active: activeCount,
    inactive: inactiveCount,
    pendingApproval,
    rejected: rejectedCount,
    banned: bannedCount,
    newThisMonth,
  };

  /* ── Fetch & enrich ── */
  let tutors: any[];
  let filteredTotal: number;

  const selectFields =
    "firstname lastname email phoneNumber profilePicture address bio " +
    "specializations education languages nativeLanguage hourlyRate " +
    "yearsOfExperience certifications averageRating totalLessons " +
    "totalStudents numberOfReviews completionRate responseTime " +
    "teachingPreferences createdAt lastLogin isActive status";

  if (needsExternalSort) {
    // Fetch all matching, enrich with wallet data, sort, paginate
    const allTutors = await User.find(filter).select(selectFields).lean();

    const enriched = await Promise.all(allTutors.map((t) => enrichTutor(t)));
    enriched.sort((a, b) => b.totalEarned - a.totalEarned);

    filteredTotal = enriched.length;
    tutors = enriched.slice(skip, skip + limit);
  } else {
    const [dbTutors, dbTotal] = await Promise.all([
      User.find(filter)
        .select(selectFields)
        .sort(sortOption)
        .skip(skip)
        .limit(limit)
        .lean(),
      User.countDocuments(filter),
    ]);

    filteredTotal = dbTotal;
    tutors = await Promise.all(dbTutors.map((t) => enrichTutor(t)));
  }

  return new ApiResponse(200, "Admin tutors retrieved successfully", {
    stats,
    tutors,
    pagination: {
      page,
      limit,
      total: filteredTotal,
      totalPages: Math.ceil(filteredTotal / limit),
    },
  });
};

/* ── Helper: enrich a single tutor document ── */

async function enrichTutor(t: any) {
  const [wallet, completedLessons, totalReviews] = await Promise.all([
    Wallet.findOne({ tutorId: t._id }).select("totalEarned").lean(),
    Booking.countDocuments({ tutorId: t._id, status: "completed" }),
    Review.countDocuments({ tutorId: t._id }),
  ]);

  // Map qualifications from education + certifications
  const qualifications: Array<{
    title: string;
    institution: string;
    year: number;
  }> = [];

  if (t.certifications && t.certifications.length > 0) {
    for (const c of t.certifications) {
      qualifications.push({
        title: c.name,
        institution: c.issuedBy,
        year: parseInt(c.year, 10) || 0,
      });
    }
  }
  if (t.education && t.education.length > 0) {
    for (const e of t.education) {
      qualifications.push({
        title: e.degree,
        institution: e.institution,
        year: parseInt(e.year, 10) || 0,
      });
    }
  }

  // Map languages
  const languages = (t.languages || []).map((l: any) => ({
    language: l.name,
    level: l.fluency
      ? l.fluency.charAt(0).toUpperCase() + l.fluency.slice(1)
      : "Unknown",
  }));

  // Map CEFR levels from teachingPreferences.preferredLevels
  const levelMap: Record<string, string> = {
    beginner: "A1",
    elementary: "A2",
    intermediate: "B1",
    "upper-intermediate": "B2",
    advanced: "C1",
  };
  const cefrLevels = (t.teachingPreferences?.preferredLevels || []).map(
    (l: string) => levelMap[l] || l.toUpperCase()
  );

  return {
    id: t._id.toString(),
    name: `${t.firstname} ${t.lastname}`,
    avatar: t.profilePicture || undefined,
    email: t.email,
    phone: t.phoneNumber || "",
    country: t.address?.country || "Unknown",
    countryCode: (t.address?.country || "UN").substring(0, 2).toUpperCase(),
    city: t.address?.city || "",
    joinedDate: t.createdAt.toISOString(),
    lastActive: (t.lastLogin || t.createdAt).toISOString(),
    status: mapTutorStatus(t),
    bio: t.bio || "",
    specialties: t.specializations || [],
    qualifications,
    languages,
    cefrLevels,
    hourlyRate: t.hourlyRate || 0,
    totalLessons: t.totalLessons || 0,
    completedLessons,
    totalStudents: t.totalStudents || 0,
    totalEarned: wallet?.totalEarned || 0,
    averageRating: t.averageRating || 0,
    totalReviews: totalReviews || t.numberOfReviews || 0,
    completionRate: t.completionRate || 0,
    responseRate: t.responseTime
      ? Math.min(100, Math.round(100 - t.responseTime / 10))
      : 0,
    applicationNote: undefined as string | undefined,
  };
}

/* ── Helper: map DB user status to frontend tutor status ── */

function mapTutorStatus(
  user: any
): "active" | "inactive" | "pending_approval" | "rejected" | "banned" {
  if (!user.isActive && user.status === "suspended") return "banned";
  if (user.status === "terminated") return "rejected";
  if (user.status === "unverified") return "pending_approval";
  if (user.isActive && user.status === "active") {
    // Check for inactivity (no login in 30 days)
    if (
      user.lastLogin &&
      user.lastLogin.getTime() < Date.now() - 30 * 24 * 60 * 60 * 1000
    ) {
      return "inactive";
    }
    return "active";
  }
  return "inactive";
}

/* ══════════════════════════════════════════════
   UPDATE TUTOR STATUS (admin action)
   ══════════════════════════════════════════════ */

export const adminUpdateTutorStatusService = async (
  tutorId: string,
  data: IAdminUpdateTutorStatusRequest
) => {
  const user = await User.findById(tutorId);
  if (!user) {
    throw new ApiError(404, "Tutor not found");
  }
  if (user.role !== "tutor") {
    throw new ApiError(400, "User is not a tutor");
  }

  switch (data.status) {
    case "active": {
      // Approve / Reactivate / Unban / Re-approve
      user.isActive = true;
      user.status = "active";
      user.verified = true;
      await user.save();

      const wasPending = !user.verified;

      createNotification({
        userId: user._id,
        type: "account_reactivated",
        title: wasPending ? "Application Approved" : "Account Reactivated",
        message: wasPending
          ? "Congratulations! Your tutor application has been approved. You can now set up your availability and start receiving bookings."
          : "Your account has been reactivated. Welcome back! You can now access all features.",
        data: {
          reactivatedAt: new Date().toISOString(),
        },
      }).catch((err) => console.error("Error creating notification:", err));
      break;
    }

    case "inactive": {
      // Deactivate (soft)
      // We keep status as "active" but mark a deactivation flag
      // Since there's no specific "inactive" status in the schema,
      // we can use the same approach: the frontend maps based on lastLogin
      // For an explicit admin deactivation, we set isActive to false
      // but keep status as "active" to distinguish from "suspended"
      user.isActive = false;
      user.status = "active";
      await user.save();

      createNotification({
        userId: user._id,
        type: "account_suspended",
        title: "Account Deactivated",
        message:
          "Your account has been temporarily deactivated by an administrator. Please contact support for more information.",
        data: {
          reason: data.reason || "Deactivated by admin",
          deactivatedAt: new Date().toISOString(),
        },
      }).catch((err) =>
        console.error("Error creating deactivation notification:", err)
      );
      break;
    }

    case "rejected": {
      // Reject application
      user.status = "terminated";
      user.isActive = false;
      await user.save();

      createNotification({
        userId: user._id,
        type: "account_suspended",
        title: "Application Not Approved",
        message: data.reason
          ? `Your tutor application was not approved. Reason: ${data.reason}`
          : "Your tutor application was not approved at this time. Please contact support for more details.",
        data: {
          reason: data.reason || "Application rejected",
          rejectedAt: new Date().toISOString(),
        },
      }).catch((err) =>
        console.error("Error creating rejection notification:", err)
      );
      break;
    }

    case "banned": {
      // Suspend / Ban
      user.isActive = false;
      user.status = "suspended";
      user.suspendedAt = new Date();
      user.suspendedReason = data.reason || "Banned by admin";
      await user.save();

      createNotification({
        userId: user._id,
        type: "account_suspended",
        title: "Account Suspended",
        message: `Your account has been suspended.${
          data.reason ? ` Reason: ${data.reason}` : ""
        } Contact support if you believe this is an error.`,
        data: {
          reason: data.reason || "Banned by admin",
          suspendedAt: user.suspendedAt.toISOString(),
        },
      }).catch((err) => console.error("Error creating ban notification:", err));
      break;
    }

    default:
      throw new ApiError(400, `Invalid status: ${data.status}`);
  }

  return new ApiResponse(200, "Tutor status updated successfully", {
    id: user._id.toString(),
    status: data.status,
  });
};
