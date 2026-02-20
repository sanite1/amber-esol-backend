import User from "../models/User";
import Booking from "../models/Booking";
import Availability from "../models/Availability";
import Transaction from "../models/Transaction";
import Payout from "../models/Payout";
import Conversation from "../models/Conversation";
import Message from "../models/Message";
import Review from "../models/Review";
import ApiError from "../errors/apiError";
import {
  ITutorDashboardQuery,
  ITutorDashboardResponse,
  IDashboardWelcome,
  IDashboardStats,
  IDashboardUpcomingLesson,
  IDashboardPendingBooking,
  IDashboardEarnings,
  IDashboardAvailability,
  IDashboardPerformance,
  IDashboardRecentMessage,
} from "../interfaces/tutorDashboard.interface";

/* ══════════════════════════════════════════════
   Helper: count weekly slots from schedule
   ══════════════════════════════════════════════ */

function countWeeklySlots(
  weeklySchedule: Array<{
    day: string;
    enabled: boolean;
    blocks: Array<{ startTime: string; endTime: string }>;
  }>,
  bufferMinutes: number,
  slotDuration: number = 60
): number {
  let total = 0;
  for (const day of weeklySchedule) {
    if (!day.enabled) continue;
    for (const block of day.blocks) {
      const [sh, sm] = block.startTime.split(":").map(Number);
      const [eh, em] = block.endTime.split(":").map(Number);
      const startMin = sh * 60 + sm;
      const endMin = eh * 60 + em;
      const available = endMin - startMin;
      if (available <= 0) continue;
      const slotsInBlock = Math.floor(
        (available + bufferMinutes) / (slotDuration + bufferMinutes)
      );
      total += slotsInBlock;
    }
  }
  return total;
}

/* ══════════════════════════════════════════════
   Main service
   ══════════════════════════════════════════════ */

export const getTutorDashboardService = async (
  tutorId: string,
  query: ITutorDashboardQuery
): Promise<ITutorDashboardResponse> => {
  const upcomingLimit = Math.min(parseInt(query.upcomingLimit || "10", 10), 20);
  const messagesLimit = Math.min(parseInt(query.messagesLimit || "4", 10), 10);

  /* ── 1. Tutor user record ── */

  const tutor = await User.findById(tutorId);
  if (!tutor || tutor.role !== "tutor") {
    throw new ApiError(404, "Tutor not found");
  }

  /* ── 2. Dates ── */

  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10); // "YYYY-MM-DD"

  // Start of current week (Monday)
  const startOfWeek = new Date(now);
  startOfWeek.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  startOfWeek.setHours(0, 0, 0, 0);
  const startOfWeekStr = startOfWeek.toISOString().slice(0, 10);

  const endOfWeek = new Date(startOfWeek);
  endOfWeek.setDate(startOfWeek.getDate() + 7);
  const endOfWeekStr = endOfWeek.toISOString().slice(0, 10);

  // Current month
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOfMonthStr = startOfMonth.toISOString().slice(0, 10);

  // Last month
  const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0);
  const startOfLastMonthStr = startOfLastMonth.toISOString().slice(0, 10);
  const endOfLastMonthStr = endOfLastMonth.toISOString().slice(0, 10);

  /* ── 3. Parallel queries ── */

  const [
    upcomingBookings,
    todayBookings,
    weekBookings,
    thisMonthCompleted,
    lastMonthCompleted,
    allCompletedCount,
    availabilityDoc,
    totalEarningsAgg,
    thisMonthEarningsAgg,
    lastMonthEarningsAgg,
    pendingPayoutsAgg,
    conversations,
    reviewStats,
    uniqueStudentsCount,
    repeatStudentsAgg,
  ] = await Promise.all([
    // Upcoming lessons (confirmed + pending, date >= today)
    Booking.find({
      tutorId,
      status: { $in: ["confirmed", "pending"] },
      date: { $gte: todayStr },
    })
      .populate(
        "studentId",
        "firstname lastname profilePicture learningPreferences"
      )
      .sort({ date: 1, startTime: 1 })
      .limit(upcomingLimit)
      .lean(),

    // Today's lessons count
    Booking.countDocuments({
      tutorId,
      status: { $in: ["confirmed", "pending"] },
      date: todayStr,
    }),

    // This week's booked slots
    Booking.countDocuments({
      tutorId,
      status: { $in: ["confirmed", "pending"] },
      date: { $gte: startOfWeekStr, $lt: endOfWeekStr },
    }),

    // This month completed
    Booking.countDocuments({
      tutorId,
      status: "completed",
      date: { $gte: startOfMonthStr },
    }),

    // Last month completed
    Booking.countDocuments({
      tutorId,
      status: "completed",
      date: { $gte: startOfLastMonthStr, $lte: endOfLastMonthStr },
    }),

    // All-time completed count
    Booking.countDocuments({
      tutorId,
      status: "completed",
    }),

    // Availability schedule
    Availability.findOne({ tutorId }).lean(),

    // Total earnings (all-time)
    Transaction.aggregate([
      { $match: { tutorId: tutor._id, status: "completed" } },
      { $group: { _id: null, total: { $sum: "$tutorEarnings" } } },
    ]),

    // This month earnings
    Transaction.aggregate([
      {
        $match: {
          tutorId: tutor._id,
          status: "completed",
          createdAt: { $gte: startOfMonth },
        },
      },
      { $group: { _id: null, total: { $sum: "$tutorEarnings" } } },
    ]),

    // Last month earnings
    Transaction.aggregate([
      {
        $match: {
          tutorId: tutor._id,
          status: "completed",
          createdAt: { $gte: startOfLastMonth, $lte: endOfLastMonth },
        },
      },
      { $group: { _id: null, total: { $sum: "$tutorEarnings" } } },
    ]),

    // Pending payouts
    Payout.aggregate([
      {
        $match: {
          tutorId: tutor._id,
          status: { $in: ["pending", "processing"] },
        },
      },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]),

    // Recent conversations
    Conversation.find({ participants: tutorId })
      .populate("participants", "firstname lastname profilePicture role")
      .populate("lastMessage")
      .sort({ updatedAt: -1 })
      .limit(messagesLimit)
      .lean(),

    // Review stats
    Review.aggregate([
      { $match: { tutorId: tutor._id } },
      {
        $group: {
          _id: null,
          avgRating: { $avg: "$rating" },
          count: { $sum: 1 },
        },
      },
    ]),

    // Unique students (all-time)
    Booking.distinct("studentId", {
      tutorId,
      status: { $in: ["confirmed", "completed"] },
    }),

    // Repeat students (students with 2+ bookings)
    Booking.aggregate([
      {
        $match: {
          tutorId: tutor._id,
          status: { $in: ["confirmed", "completed"] },
        },
      },
      { $group: { _id: "$studentId", count: { $sum: 1 } } },
      { $match: { count: { $gte: 2 } } },
      { $count: "repeatStudents" },
    ]),
  ]);

  /* ── 4. Build welcome ── */

  const confirmedUpcoming = upcomingBookings.filter(
    (b: any) => b.status === "confirmed" && b.date === todayStr
  );
  const nextLesson = confirmedUpcoming[0] as any;

  const welcome: IDashboardWelcome = {
    firstName: tutor.firstname,
    avatarUrl: tutor.profilePicture || "",
    isOnline: tutor.onlineStatus === "online",
    todayLessons: todayBookings,
    nextLessonTime: nextLesson?.startTime || null,
    averageRating: tutor.averageRating || 0,
    totalStudents: tutor.totalStudents || uniqueStudentsCount.length,
  };

  /* ── 5. Build stats ── */

  const stats: IDashboardStats = {
    totalLessons: tutor.totalLessons || allCompletedCount,
    totalStudents: tutor.totalStudents || uniqueStudentsCount.length,
    averageRating: tutor.averageRating || 0,
    completionRate: tutor.completionRate || 0,
  };

  /* ── 6. Build upcoming lessons & pending bookings ── */

  const upcomingLessons: IDashboardUpcomingLesson[] = [];
  const pendingBookings: IDashboardPendingBooking[] = [];

  for (const b of upcomingBookings as any[]) {
    const student = typeof b.studentId === "object" ? b.studentId : null;
    const studentName = student
      ? `${student.firstname} ${student.lastname}`
      : "Unknown Student";
    const studentAvatar = student?.profilePicture || "";
    const studentLevel =
      student?.learningPreferences?.currentLevel || "Unknown";

    if (b.status === "confirmed" || b.status === "pending") {
      upcomingLessons.push({
        id: b._id.toString(),
        studentName,
        studentAvatar,
        studentLevel,
        lessonType: b.type,
        status: b.status,
        specialty: b.specialty || "General English",
        date: b.date,
        startTime: b.startTime,
        endTime: b.endTime,
        meetingUrl: b.meetingUrl || null,
        notes: b.notes || null,
      });
    }

    if (b.status === "pending") {
      pendingBookings.push({
        id: b._id.toString(),
        studentName,
        studentAvatar,
        studentLevel,
        lessonType: b.type,
        hoursRequested: 1,
        totalAmount: b.price || 0,
        requestedDate: b.createdAt?.toISOString?.() || b.createdAt,
        message: b.message || b.notes || null,
      });
    }
  }

  /* ── 7. Build earnings ── */

  const totalEarnings = totalEarningsAgg[0]?.total || 0;
  const thisMonthEarnings = thisMonthEarningsAgg[0]?.total || 0;
  const lastMonthEarnings = lastMonthEarningsAgg[0]?.total || 0;
  const pendingPayout = pendingPayoutsAgg[0]?.total || 0;

  // Estimate next payout date: last day of current month
  const nextPayoutDate = new Date(
    now.getFullYear(),
    now.getMonth() + 1,
    0
  ).toISOString();

  const earnings: IDashboardEarnings = {
    thisMonthEarnings,
    lastMonthEarnings,
    totalEarnings,
    pendingPayout,
    nextPayoutDate,
    completedLessonsThisMonth: thisMonthCompleted,
  };

  /* ── 8. Build availability ── */

  const schedule = (availabilityDoc as any)?.weeklySchedule;
  const bufferMinutes = (availabilityDoc as any)?.bufferMinutes ?? 10;
  const totalSlotsThisWeek = schedule
    ? countWeeklySlots(schedule, bufferMinutes)
    : 0;

  // Find next available slot from upcoming confirmed lessons
  let nextAvailableSlot: string | null = null;
  const nextConfirmed = upcomingBookings.find(
    (b: any) =>
      b.status === "confirmed" && new Date(`${b.date}T${b.startTime}:00`) > now
  ) as any;
  if (nextConfirmed) {
    nextAvailableSlot = `${nextConfirmed.date}T${nextConfirmed.startTime}:00`;
  }

  const availability: IDashboardAvailability = {
    totalSlotsThisWeek,
    bookedSlotsThisWeek: weekBookings,
    nextAvailableSlot,
  };

  /* ── 9. Build performance ── */

  const avgRating = reviewStats[0]?.avgRating || tutor.averageRating || 0;
  const numberOfReviews = reviewStats[0]?.count || tutor.numberOfReviews || 0;
  const totalStudentsCount = uniqueStudentsCount.length;
  const repeatStudentsCount = repeatStudentsAgg[0]?.repeatStudents || 0;
  const repeatStudentRate =
    totalStudentsCount > 0
      ? Math.round((repeatStudentsCount / totalStudentsCount) * 100)
      : 0;

  const performance: IDashboardPerformance = {
    averageRating: Math.round(avgRating * 10) / 10,
    responseRate: 0,
    completionRate: tutor.completionRate || 0,
    repeatStudentRate,
    numberOfReviews,
    totalLessons: tutor.totalLessons || allCompletedCount,
  };

  /* ── 10. Build recent messages ── */

  const recentMessages: IDashboardRecentMessage[] = [];

  for (const convo of conversations as any[]) {
    // Find the student participant (not the tutor)
    const student = convo.participants?.find(
      (p: any) => p._id.toString() !== tutorId && p.role === "student"
    );
    if (!student) continue;

    const lastMsg = convo.lastMessage;
    const unreadCount = await Message.countDocuments({
      conversationId: convo._id,
      senderId: { $ne: tutorId },
      read: false,
    });

    recentMessages.push({
      id: convo._id.toString(),
      studentName: `${student.firstname} ${student.lastname}`,
      studentAvatar: student.profilePicture || "",
      lastMessage: lastMsg?.content || lastMsg?.message || "",
      timestamp: convo.updatedAt?.toISOString?.() || convo.updatedAt,
      unread: unreadCount > 0,
    });
  }

  /* ── 11. Return ── */

  return {
    message: "Tutor dashboard fetched successfully",
    data: {
      welcome,
      stats,
      upcomingLessons,
      pendingBookings,
      earnings,
      availability,
      performance,
      recentMessages,
    },
  };
};
