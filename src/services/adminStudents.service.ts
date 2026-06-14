import ApiError from "../errors/apiError";
import ApiResponse from "../errors/apiResponse";
import User from "../models/User";
import Booking from "../models/Booking";
import Transaction from "../models/Transaction";
import {
  IAdminStudentsQuery,
  IAdminUpdateStudentStatusRequest,
} from "../interfaces/adminStudents.interface";
import { createNotification } from "./notification.service";
import logger from "../config/logger";

/* ══════════════════════════════════════════════
   GET ADMIN STUDENTS (list + stats)
   ══════════════════════════════════════════════ */

export const getAdminStudentsService = async (query: IAdminStudentsQuery) => {
  const page = parseInt(query.page || "1", 10);
  const limit = parseInt(query.limit || "10", 10);
  const skip = (page - 1) * limit;

  /* ── Base filter ── */
  const filter: any = { role: "student" };

  /* ── Status filter ── */
  if (query.status && query.status !== "all") {
    switch (query.status) {
      case "active":
        filter.isActive = true;
        filter.status = { $ne: "terminated" };
        break;
      case "inactive":
        filter.isActive = true;
        filter.status = "unverified";
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
    ];
  }

  /* ── Sort ── */
  let sortOption: any = { createdAt: -1 }; // default: newest
  switch (query.sort) {
    case "name":
      sortOption = { firstname: 1, lastname: 1 };
      break;
    case "spent":
      // Will sort after enrichment
      break;
    case "lessons":
      sortOption = { totalLessonsTaken: -1 };
      break;
    case "recent":
      sortOption = { lastLogin: -1 };
      break;
    default:
      sortOption = { createdAt: -1 };
  }

  /* ── Stats (parallel) ── */
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const [total, activeCount, inactiveCount, bannedCount, newThisMonth] =
    await Promise.all([
      User.countDocuments({ role: "student" }),
      User.countDocuments({
        role: "student",
        isActive: true,
        status: { $nin: ["suspended", "terminated", "unverified"] },
      }),
      User.countDocuments({
        role: "student",
        $or: [
          { status: "unverified" },
          {
            isActive: true,
            lastLogin: { $lt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
          },
        ],
      }),
      User.countDocuments({
        role: "student",
        isActive: false,
        status: "suspended",
      }),
      User.countDocuments({
        role: "student",
        createdAt: { $gte: startOfMonth },
      }),
    ]);

  const stats = {
    total,
    active: activeCount,
    inactive: inactiveCount,
    banned: bannedCount,
    newThisMonth,
  };

  /* ── Need to handle "spent" sort specially ── */
  const needsSpentSort = query.sort === "spent";

  /* ── Fetch students ── */
  let students;
  let filteredTotal: number;

  if (needsSpentSort) {
    // Fetch all matching, enrich, sort, then paginate
    const allStudents = await User.find(filter)
      .select(
        "firstname lastname email profilePicture address learningPreferences " +
          "createdAt lastLogin isActive status totalLessonsTaken",
      )
      .lean();

    // Enrich with spending
    const enriched = await Promise.all(
      allStudents.map(async (s) => {
        const [completedLessons, totalSpent, hasTrialBooking, activeTutor] =
          await Promise.all([
            Booking.countDocuments({ studentId: s._id, status: "completed" }),
            Transaction.aggregate([
              { $match: { studentId: s._id, status: "paid" } },
              { $group: { _id: null, total: { $sum: "$amount" } } },
            ]).then((r) => (r.length > 0 ? r[0].total : 0)),
            Booking.exists({ studentId: s._id, type: "trial" }),
            Booking.findOne({
              studentId: s._id,
              status: { $in: ["confirmed", "pending"] },
            })
              .sort({ date: -1 })
              .populate("tutorId", "firstname lastname")
              .lean(),
          ]);

        const tutorDoc =
          activeTutor && typeof activeTutor.tutorId === "object"
            ? (activeTutor.tutorId as any)
            : null;

        return {
          id: s._id.toString(),
          name: `${s.firstname} ${s.lastname}`,
          avatar: s.profilePicture || undefined,
          email: s.email,
          country: s.address?.country || "Unknown",
          countryCode: (s.address?.country || "UN")
            .substring(0, 2)
            .toUpperCase(),
          level: s.learningPreferences?.currentLevel?.toUpperCase() || "A1",
          joinedDate: s.createdAt.toISOString(),
          lastActive: (s.lastLogin || s.createdAt).toISOString(),
          status: mapUserStatus(s),
          totalLessons: s.totalLessonsTaken || 0,
          completedLessons,
          totalSpent: Math.round(totalSpent * 100) / 100,
          activeTutor: tutorDoc
            ? `${tutorDoc.firstname} ${tutorDoc.lastname}`
            : undefined,
          trialUsed: !!hasTrialBooking,
        };
      }),
    );

    enriched.sort((a, b) => b.totalSpent - a.totalSpent);
    filteredTotal = enriched.length;
    students = enriched.slice(skip, skip + limit);
  } else {
    // Paginate at DB level
    const [dbStudents, dbTotal] = await Promise.all([
      User.find(filter)
        .select(
          "firstname lastname email profilePicture address learningPreferences " +
            "createdAt lastLogin isActive status totalLessonsTaken",
        )
        .sort(sortOption)
        .skip(skip)
        .limit(limit)
        .lean(),
      User.countDocuments(filter),
    ]);

    filteredTotal = dbTotal;

    // Enrich each student
    students = await Promise.all(
      dbStudents.map(async (s) => {
        const [completedLessons, totalSpent, hasTrialBooking, activeTutor] =
          await Promise.all([
            Booking.countDocuments({ studentId: s._id, status: "completed" }),
            Transaction.aggregate([
              { $match: { studentId: s._id, status: "paid" } },
              { $group: { _id: null, total: { $sum: "$amount" } } },
            ]).then((r) => (r.length > 0 ? r[0].total : 0)),
            Booking.exists({ studentId: s._id, type: "trial" }),
            Booking.findOne({
              studentId: s._id,
              status: { $in: ["confirmed", "pending"] },
            })
              .sort({ date: -1 })
              .populate("tutorId", "firstname lastname")
              .lean(),
          ]);

        const tutorDoc =
          activeTutor && typeof activeTutor.tutorId === "object"
            ? (activeTutor.tutorId as any)
            : null;

        return {
          id: s._id.toString(),
          name: `${s.firstname} ${s.lastname}`,
          avatar: s.profilePicture || undefined,
          email: s.email,
          country: s.address?.country || "Unknown",
          countryCode: (s.address?.country || "UN")
            .substring(0, 2)
            .toUpperCase(),
          level: s.learningPreferences?.currentLevel?.toUpperCase() || "A1",
          joinedDate: s.createdAt.toISOString(),
          lastActive: (s.lastLogin || s.createdAt).toISOString(),
          status: mapUserStatus(s),
          totalLessons: s.totalLessonsTaken || 0,
          completedLessons,
          totalSpent: Math.round(totalSpent * 100) / 100,
          activeTutor: tutorDoc
            ? `${tutorDoc.firstname} ${tutorDoc.lastname}`
            : undefined,
          trialUsed: !!hasTrialBooking,
        };
      }),
    );
  }

  return new ApiResponse(200, "Admin students retrieved successfully", {
    stats,
    students,
    pagination: {
      page,
      limit,
      total: filteredTotal,
      totalPages: Math.ceil(filteredTotal / limit),
    },
  });
};

/* ══════════════════════════════════════════════
   UPDATE STUDENT STATUS (admin action)
   ══════════════════════════════════════════════ */

export const adminUpdateStudentStatusService = async (
  studentId: string,
  data: IAdminUpdateStudentStatusRequest,
) => {
  const user = await User.findById(studentId);
  if (!user) {
    throw new ApiError(404, "Student not found");
  }
  if (user.role !== "student") {
    throw new ApiError(400, "User is not a student");
  }

  switch (data.status) {
    case "active": {
      // Reactivate / Unban
      user.isActive = true;
      user.status = "active";
      await user.save();

      createNotification({
        userId: user._id,
        type: "account_reactivated",
        title: "Account Reactivated",
        message:
          "Your account has been reactivated. Welcome back! You can now access all features.",
        data: { reactivatedAt: new Date().toISOString() },
      }).catch((err) =>
        logger.error({ err }, "Error creating reactivation notification"),
      );
      break;
    }

    case "inactive": {
      // Deactivate (soft — user can still log in but marked inactive)
      user.status = "unverified"; // re-using existing status enum
      await user.save();
      break;
    }

    case "banned": {
      // Suspend
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
      }).catch((err) =>
        logger.error({ err }, "Error creating suspension notification"),
      );
      break;
    }

    default:
      throw new ApiError(400, `Invalid status: ${data.status}`);
  }

  return new ApiResponse(200, "Student status updated successfully", {
    id: user._id.toString(),
    status: data.status,
  });
};

/* ── Helper: map DB user status to frontend status ── */

function mapUserStatus(user: any): "active" | "inactive" | "banned" {
  if (!user.isActive && user.status === "suspended") return "banned";
  if (user.status === "unverified") return "inactive";
  if (user.isActive && user.status === "active") return "active";
  // Default fallback based on isActive
  return user.isActive ? "active" : "inactive";
}
