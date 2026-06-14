import ApiError from "../errors/apiError";
import ApiResponse from "../errors/apiResponse";
import User from "../models/User";
import Booking from "../models/Booking";
import Transaction from "../models/Transaction";
import Payout from "../models/Payout";
import Review from "../models/Review";
import { IAdminDashboardQuery } from "../interfaces/adminDashboard.interface";

/* ── Constants ── */
const PLATFORM_COMMISSION_RATE = 15; // percentage

/* ══════════════════════════════════════════════
   GET ADMIN DASHBOARD
   ══════════════════════════════════════════════ */

export const getAdminDashboardService = async (query: IAdminDashboardQuery) => {
  /* ── Parse optional limits ── */
  const signupsLimit = parseInt(query.signupsLimit || "7", 10);
  const lessonsLimit = parseInt(query.lessonsLimit || "6", 10);
  const transactionsLimit = parseInt(query.transactionsLimit || "5", 10);
  const chartMonths = parseInt(query.chartMonths || "6", 10);

  /* ── Date helpers ── */
  const now = new Date();
  const todayStr = now.toISOString().split("T")[0];

  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthStr = startOfMonth.toISOString().split("T")[0];

  const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0);
  const lastMonthStartStr = startOfLastMonth.toISOString().split("T")[0];
  const lastMonthEndStr = endOfLastMonth.toISOString().split("T")[0];

  const startOfWeek = new Date(now);
  startOfWeek.setDate(now.getDate() - now.getDay() + 1); // Monday
  startOfWeek.setHours(0, 0, 0, 0);
  const weekStr = startOfWeek.toISOString().split("T")[0];

  /* ══════════════════════════════════════════════
     PARALLEL QUERIES — stats
     ══════════════════════════════════════════════ */
  const [
    totalStudents,
    totalTutors,
    activeTutors,
    pendingTutorApprovals,
    totalLessons,
    lessonsToday,
    lessonsThisWeek,
    completedLessonsTotal,
    allLessonsTotal,
    // Revenue: this month transactions
    thisMonthTransactions,
    // Revenue: last month transactions
    lastMonthTransactions,
    // Revenue: all time
    allTransactions,
    // Pending payouts
    pendingPayouts,
    // Reported reviews
    reportedReviews,
    // Active lessons now (confirmed bookings happening today — simplified)
    activeLessonsNow,
  ] = await Promise.all([
    // 1. Total students
    User.countDocuments({ role: "student" }),

    // 2. Total tutors
    User.countDocuments({ role: "tutor" }),

    // 3. Active tutors
    User.countDocuments({ role: "tutor", isActive: true, status: "active" }),

    // 4. Pending tutor approvals
    User.countDocuments({ role: "tutor", status: "unverified" }),

    // 5. Total lessons (all bookings ever)
    Booking.countDocuments(),

    // 6. Lessons today
    Booking.countDocuments({ date: todayStr }),

    // 7. Lessons this week
    Booking.countDocuments({ date: { $gte: weekStr } }),

    // 8. Completed lessons (for completion rate)
    Booking.countDocuments({ status: "completed" }),

    // 9. All non-pending lessons (for completion rate denominator)
    Booking.countDocuments({
      status: {
        $in: [
          "completed",
          "no_show",
          "cancelled_student",
          "cancelled_tutor",
          "cancelled_admin",
        ],
      },
    }),

    // 10. This month transactions (paid)
    Transaction.find({
      status: "paid",
      createdAt: { $gte: startOfMonth },
    }).select("amount platformCommission tutorEarnings"),

    // 11. Last month transactions
    Transaction.find({
      status: "paid",
      createdAt: { $gte: startOfLastMonth, $lte: endOfLastMonth },
    }).select("amount"),

    // 12. All transactions (total revenue)
    Transaction.find({ status: "paid" }).select("amount"),

    // 13. Pending payouts
    Payout.find({ status: { $in: ["pending", "processing"] } }).select(
      "amount status",
    ),

    // 14. Reported reviews
    Review.countDocuments({ reported: true, "reports.status": "pending" }),

    // 15. Active lessons now (confirmed lessons today)
    Booking.countDocuments({
      date: todayStr,
      status: "confirmed",
    }),
  ]);

  /* ── Compute revenue stats ── */
  const revenueThisMonth = thisMonthTransactions.reduce(
    (sum, t) => sum + t.amount,
    0,
  );
  const commissionEarnedThisMonth = thisMonthTransactions.reduce(
    (sum, t) => sum + t.platformCommission,
    0,
  );
  const revenueLastMonth = lastMonthTransactions.reduce(
    (sum, t) => sum + t.amount,
    0,
  );
  const totalRevenue = allTransactions.reduce((sum, t) => sum + t.amount, 0);

  // Revenue trend
  let revenueTrend: "up" | "down" | "stable" = "stable";
  let revenueTrendPct = 0;
  if (revenueLastMonth > 0) {
    const diff = revenueThisMonth - revenueLastMonth;
    revenueTrendPct =
      Math.round((Math.abs(diff) / revenueLastMonth) * 1000) / 10;
    if (diff > 0) revenueTrend = "up";
    else if (diff < 0) revenueTrend = "down";
  } else if (revenueThisMonth > 0) {
    revenueTrend = "up";
    revenueTrendPct = 100;
  }

  // Completion rate
  const completionRate =
    allLessonsTotal > 0
      ? Math.round((completedLessonsTotal / allLessonsTotal) * 1000) / 10
      : 100;

  // Pending payouts aggregation
  const pendingPayoutsCount = pendingPayouts.length;
  const pendingPayoutsAmount = pendingPayouts.reduce(
    (sum, p) => sum + p.amount,
    0,
  );

  /* ── Build stats object ── */
  const stats = {
    totalStudents,
    totalTutors,
    activeTutors,
    pendingTutorApprovals,
    totalLessons,
    lessonsToday,
    lessonsThisWeek,
    completionRate,
    totalRevenue: Math.round(totalRevenue * 100) / 100,
    revenueThisMonth: Math.round(revenueThisMonth * 100) / 100,
    revenueLastMonth: Math.round(revenueLastMonth * 100) / 100,
    revenueTrend,
    revenueTrendPct,
    platformCommission: PLATFORM_COMMISSION_RATE,
    commissionEarnedThisMonth:
      Math.round(commissionEarnedThisMonth * 100) / 100,
    pendingPayouts: pendingPayoutsCount,
    pendingPayoutsAmount: Math.round(pendingPayoutsAmount * 100) / 100,
    reportedReviews,
    activeLessonsNow,
  };

  /* ══════════════════════════════════════════════
     MONTHLY REVENUE CHART
     ══════════════════════════════════════════════ */
  const monthLabels = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];

  const monthlyRevenue: Array<{
    month: string;
    label: string;
    revenue: number;
    commission: number;
    lessons: number;
  }> = [];

  for (let i = chartMonths - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const mStart = new Date(d.getFullYear(), d.getMonth(), 1);
    const mEnd = new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59);
    const mStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const mStartStr = mStart.toISOString().split("T")[0];
    const mEndStr = mEnd.toISOString().split("T")[0];

    const [monthTxs, monthLessonCount] = await Promise.all([
      Transaction.find({
        status: "paid",
        createdAt: { $gte: mStart, $lte: mEnd },
      }).select("amount platformCommission"),
      Booking.countDocuments({
        date: { $gte: mStartStr, $lte: mEndStr },
        status: { $in: ["completed", "confirmed", "pending"] },
      }),
    ]);

    const mRevenue = monthTxs.reduce((s, t) => s + t.amount, 0);
    const mCommission = monthTxs.reduce((s, t) => s + t.platformCommission, 0);

    monthlyRevenue.push({
      month: mStr,
      label: monthLabels[d.getMonth()],
      revenue: Math.round(mRevenue * 100) / 100,
      commission: Math.round(mCommission * 100) / 100,
      lessons: monthLessonCount,
    });
  }

  /* ══════════════════════════════════════════════
     RECENT SIGNUPS
     ══════════════════════════════════════════════ */
  const recentUsers = await User.find({
    role: { $in: ["student", "tutor"] },
  })
    .select("firstname lastname profilePicture role address status createdAt")
    .sort({ createdAt: -1 })
    .limit(signupsLimit);

  const recentSignups = recentUsers.map((u) => ({
    id: u._id.toString(),
    name: `${u.firstname} ${u.lastname}`,
    avatar: u.profilePicture || "",
    type: u.role as "student" | "tutor",
    country: u.address?.country || "Unknown",
    countryCode: (u.address?.country || "UN").substring(0, 2).toUpperCase(),
    date: u.createdAt.toISOString(),
    status:
      u.role === "tutor" && u.status === "unverified"
        ? "pending_approval"
        : ("active" as "active" | "pending_approval"),
  }));

  /* ══════════════════════════════════════════════
     RECENT LESSONS
     ══════════════════════════════════════════════ */
  const recentBookings = await Booking.find()
    .populate("studentId", "firstname lastname")
    .populate("tutorId", "firstname lastname")
    .sort({ createdAt: -1 })
    .limit(lessonsLimit);

  const recentLessons = recentBookings.map((b) => {
    const student =
      typeof b.studentId === "object" && b.studentId !== null
        ? (b.studentId as any)
        : { firstname: "Unknown", lastname: "Student" };
    const tutor =
      typeof b.tutorId === "object" && b.tutorId !== null
        ? (b.tutorId as any)
        : { firstname: "Unknown", lastname: "Tutor" };

    // Map booking status to dashboard lesson status
    let lessonStatus: string = "completed";
    const bookingDate = new Date(`${b.date}T${b.startTime}:00`);
    const bookingEnd = new Date(`${b.date}T${b.endTime}:00`);

    if (b.status === "completed") {
      lessonStatus = "completed";
    } else if (b.status === "no_show") {
      lessonStatus = "no_show";
    } else if (
      b.status === "cancelled_student" ||
      b.status === "cancelled_tutor" ||
      b.status === "cancelled_admin"
    ) {
      lessonStatus = "cancelled";
    } else if (
      b.status === "confirmed" &&
      now >= bookingDate &&
      now <= bookingEnd
    ) {
      lessonStatus = "in_progress";
    } else if (
      (b.status === "confirmed" || b.status === "pending") &&
      bookingDate > now
    ) {
      lessonStatus = "upcoming";
    } else {
      lessonStatus = "completed";
    }

    // Duration in minutes
    const [sh, sm] = b.startTime.split(":").map(Number);
    const [eh, em] = b.endTime.split(":").map(Number);
    const duration = eh * 60 + em - (sh * 60 + sm);

    return {
      id: b._id.toString(),
      studentName: `${student.firstname} ${student.lastname}`,
      tutorName: `${tutor.firstname} ${tutor.lastname}`,
      type: b.type as "trial" | "regular",
      status: lessonStatus,
      date: `${b.date}T${b.startTime}:00Z`,
      duration: duration > 0 ? duration : 60,
      amount: b.price,
    };
  });

  /* ══════════════════════════════════════════════
     RECENT TRANSACTIONS
     ══════════════════════════════════════════════ */

  // Fetch recent paid/refunded transactions
  const recentTxs = await Transaction.find()
    .populate("studentId", "firstname lastname")
    .populate("tutorId", "firstname lastname")
    .sort({ createdAt: -1 })
    .limit(transactionsLimit);

  // Also fetch recent payouts to merge into the transactions list
  const recentPayoutDocs = await Payout.find()
    .populate("tutorId", "firstname lastname")
    .sort({ createdAt: -1 })
    .limit(transactionsLimit);

  // Build combined transaction items
  const txItems = recentTxs.map((tx) => {
    const student =
      typeof tx.studentId === "object" && tx.studentId !== null
        ? (tx.studentId as any)
        : { firstname: "Unknown", lastname: "Student" };
    const tutor =
      typeof tx.tutorId === "object" && tx.tutorId !== null
        ? (tx.tutorId as any)
        : { firstname: "Unknown", lastname: "Tutor" };

    let txType: "payment" | "refund" = "payment";
    let txStatus: "completed" | "pending" | "processing" | "failed" =
      "completed";

    if (tx.status === "refunded") {
      txType = "refund";
      txStatus = "completed";
    } else if (tx.status === "paid") {
      txType = "payment";
      txStatus = "completed";
    } else if (tx.status === "pending") {
      txType = "payment";
      txStatus = "pending";
    } else if (tx.status === "failed") {
      txType = "payment";
      txStatus = "failed";
    }

    return {
      id: tx._id.toString(),
      studentName: `${student.firstname} ${student.lastname}`,
      tutorName: `${tutor.firstname} ${tutor.lastname}`,
      amount: tx.amount,
      type: txType,
      status: txStatus,
      date: tx.createdAt.toISOString(),
      _sortDate: tx.createdAt,
    };
  });

  const payoutItems = recentPayoutDocs.map((p) => {
    const tutor =
      typeof p.tutorId === "object" && p.tutorId !== null
        ? (p.tutorId as any)
        : { firstname: "Unknown", lastname: "Tutor" };

    let pStatus: "completed" | "pending" | "processing" | "failed" = "pending";
    if (p.status === "completed") pStatus = "completed";
    else if (p.status === "processing") pStatus = "processing";
    else if (p.status === "failed" || p.status === "flagged")
      pStatus = "failed";

    return {
      id: p._id.toString(),
      studentName: "",
      tutorName: `${tutor.firstname} ${tutor.lastname}`,
      amount: p.amount,
      type: "payout" as const,
      status: pStatus,
      date: p.createdAt.toISOString(),
      _sortDate: p.createdAt,
    };
  });

  // Merge, sort by date descending, take the limit
  const recentTransactions = [...txItems, ...payoutItems]
    .sort((a, b) => b._sortDate.getTime() - a._sortDate.getTime())
    .slice(0, transactionsLimit)
    .map(({ _sortDate, ...rest }) => rest);

  /* ══════════════════════════════════════════════
     FLAGGED ITEMS
     ══════════════════════════════════════════════ */
  const flaggedItems: Array<{
    id: string;
    type: "reported_review" | "pending_approval" | "failed_payout" | "dispute";
    title: string;
    description: string;
    date: string;
    severity: "low" | "medium" | "high";
  }> = [];

  // 1. Reported reviews with pending reports
  const reportedReviewDocs = await Review.find({
    reported: true,
    "reports.status": "pending",
  })
    .populate("studentId", "firstname lastname")
    .populate("tutorId", "firstname lastname")
    .sort({ updatedAt: -1 })
    .limit(5);

  for (const rev of reportedReviewDocs) {
    const student =
      typeof rev.studentId === "object"
        ? (rev.studentId as any)
        : { firstname: "Unknown", lastname: "" };
    const tutor =
      typeof rev.tutorId === "object"
        ? (rev.tutorId as any)
        : { firstname: "Unknown", lastname: "" };
    const pendingCount = rev.reports.filter(
      (r) => r.status === "pending",
    ).length;

    flaggedItems.push({
      id: rev._id.toString(),
      type: "reported_review",
      title: `Review reported by ${tutor.firstname} ${tutor.lastname}`,
      description: `Student ${student.firstname} ${student.lastname} left a review with ${pendingCount} pending report(s).`,
      date: rev.updatedAt.toISOString(),
      severity: pendingCount >= 2 ? "high" : "medium",
    });
  }

  // 2. Pending tutor approvals
  if (pendingTutorApprovals > 0) {
    const pendingTutors = await User.find({
      role: "tutor",
      status: "unverified",
    })
      .select("firstname lastname createdAt")
      .sort({ createdAt: -1 })
      .limit(3);

    const names = pendingTutors
      .map((t) => `${t.firstname} ${t.lastname}`)
      .join(", ");

    flaggedItems.push({
      id: "pending-approvals",
      type: "pending_approval",
      title: `${pendingTutorApprovals} tutor${pendingTutorApprovals > 1 ? "s" : ""} awaiting approval`,
      description:
        pendingTutorApprovals <= 3
          ? `${names} ${pendingTutorApprovals > 1 ? "have" : "has"} completed their application${pendingTutorApprovals > 1 ? "s" : ""}.`
          : `${names}, and ${pendingTutorApprovals - 3} more have completed their applications.`,
      date: pendingTutors[0]?.createdAt.toISOString() || now.toISOString(),
      severity: "high",
    });
  }

  // 3. Failed payouts
  const failedPayouts = await Payout.find({
    status: { $in: ["failed", "flagged"] },
  })
    .populate("tutorId", "firstname lastname")
    .sort({ updatedAt: -1 })
    .limit(3);

  for (const fp of failedPayouts) {
    const tutor =
      typeof fp.tutorId === "object"
        ? (fp.tutorId as any)
        : { firstname: "Unknown", lastname: "" };
    flaggedItems.push({
      id: fp._id.toString(),
      type: "failed_payout",
      title: `Payout failed for ${tutor.firstname} ${tutor.lastname}`,
      description:
        fp.flagReason || fp.notes || "Payout could not be processed.",
      date: fp.updatedAt.toISOString(),
      severity: "high",
    });
  }

  // Sort flagged items by severity (high first) then by date
  const severityOrder: Record<string, number> = {
    high: 0,
    medium: 1,
    low: 2,
  };
  flaggedItems.sort(
    (a, b) =>
      severityOrder[a.severity] - severityOrder[b.severity] ||
      new Date(b.date).getTime() - new Date(a.date).getTime(),
  );

  /* ══════════════════════════════════════════════
     ASSEMBLE RESPONSE
     ══════════════════════════════════════════════ */
  return new ApiResponse(200, "Admin dashboard retrieved successfully", {
    stats,
    monthlyRevenue,
    recentSignups,
    recentLessons,
    recentTransactions,
    flaggedItems,
  });
};
