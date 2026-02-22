import ApiError from "../errors/apiError";
import ApiResponse from "../errors/apiResponse";
import User from "../models/User";
import Booking from "../models/Booking";
import Transaction from "../models/Transaction";
import Conversation from "../models/Conversation";
import Message from "../models/Message";
import Review from "../models/Review";
import { IStudentDashboardQuery } from "../interfaces/studentDashboard.interface";
import { completeStaleBookings } from "../utils/completeStaleBookings";
import { hasLessonStarted, todayInTz } from "../utils/timezone";

/* ══════════════════════════════════════════════
   GET STUDENT DASHBOARD
   ══════════════════════════════════════════════ */

export const getStudentDashboardService = async (
  studentId: string,
  query: IStudentDashboardQuery
) => {
  await completeStaleBookings(studentId, "student");

  /* ── Parse optional limits ── */
  const upcomingLimit = parseInt(query.upcomingLimit || "5", 10);
  const messagesLimit = parseInt(query.messagesLimit || "4", 10);
  const recommendedLimit = parseInt(query.recommendedLimit || "3", 10);

  /* ── Fetch student record ── */
  const student = await User.findById(studentId);
  if (!student || student.role !== "student") {
    throw new ApiError(404, "Student not found");
  }

  /* ── Date helpers ── */
  const today = todayInTz("Europe/London");
  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);
  const monthStr = startOfMonth.toISOString().split("T")[0];

  /* ── Run parallel queries ── */
  const [
    // Upcoming bookings (pending + confirmed, from today onward)
    upcomingBookings,
    // Booking counts
    totalBookings,
    completedBookings,
    cancelledBookings,
    // Active tutors (distinct tutors with at least one confirmed/completed booking)
    activeTutorIds,
    // Spending: total spent (all time, paid + free)
    allPaidBookings,
    // Spending: this month (completed bookings this month)
    thisMonthCompletedBookings,
    // Spending: upcoming lessons value (pending + confirmed, from today)
    upcomingValueBookings,
    // Conversations for recent messages
    conversations,
    // Unread message count
    unreadMessages,
  ] = await Promise.all([
    // 1. Upcoming bookings
    Booking.find({
      studentId,
      status: { $in: ["pending", "confirmed"] },
      date: { $gte: today },
    })
      .populate(
        "tutorId",
        "firstname lastname profilePicture specializations hourlyRate"
      )
      .sort({ date: 1, startTime: 1 })
      .limit(upcomingLimit),

    // 2. Total bookings
    Booking.countDocuments({ studentId }),

    // 3. Completed
    Booking.countDocuments({ studentId, status: "completed" }),

    // 4. Cancelled (all cancelled variants)
    Booking.countDocuments({
      studentId,
      status: {
        $in: ["cancelled_student", "cancelled_tutor", "cancelled_admin"],
      },
    }),

    // 5. Active tutors: distinct tutor IDs from confirmed/completed bookings
    Booking.distinct("tutorId", {
      studentId,
      status: { $in: ["confirmed", "completed"] },
    }),

    // 6. All paid bookings (for total spent)
    Booking.find({
      studentId,
      paymentStatus: { $in: ["paid", "free"] },
    }).select("price"),

    // 7. This month completed bookings (for this month spending)
    Booking.find({
      studentId,
      status: "completed",
      date: { $gte: monthStr },
    }).select("price"),

    // 8. Upcoming bookings value
    Booking.find({
      studentId,
      status: { $in: ["pending", "confirmed"] },
      date: { $gte: today },
    }).select("price"),

    // 9. Conversations (for recent messages)
    Conversation.find({
      participants: studentId,
      lastMessage: { $exists: true, $ne: null },
    })
      .populate(
        "participants",
        "firstname lastname profilePicture role specializations slug onlineStatus lastSeen"
      )
      .sort({ lastMessageAt: -1 })
      .limit(messagesLimit),

    // 10. Unread message count
    Message.countDocuments({
      senderId: { $ne: studentId },
      isRead: false,
      conversationId: {
        $in: (
          await Conversation.find({ participants: studentId }).select("_id")
        ).map((c) => c._id),
      },
    }),
  ]);

  /* ── Compute spending summary ── */
  const totalSpent = allPaidBookings.reduce((sum, b) => sum + b.price, 0);
  const thisMonthSpent = thisMonthCompletedBookings.reduce(
    (sum, b) => sum + b.price,
    0
  );
  const upcomingLessonsValue = upcomingValueBookings.reduce(
    (sum, b) => sum + b.price,
    0
  );
  const totalHoursBooked = allPaidBookings.length; // 1 booking = 1 hour

  /* ── Compute learning progress ── */

  // Map CEFR levels to numeric for ordering
  const cefrOrder: Record<string, number> = {
    beginner: 0,
    elementary: 1,
    intermediate: 2,
    "upper-intermediate": 3,
    advanced: 4,
    proficiency: 5,
  };

  const currentLevel = student.learningPreferences?.currentLevel || "beginner";
  const targetLevel =
    student.learningPreferences?.targetLevel || "intermediate";

  const currentIndex = cefrOrder[currentLevel] ?? 0;
  const targetIndex = cefrOrder[targetLevel] ?? 2;
  const levelDiff = Math.max(targetIndex - currentIndex, 1);
  // Estimate ~20 lessons per CEFR level progression
  const totalLessonsNeeded = levelDiff * 20;
  const lessonsCompleted = completedBookings;

  // After fetching upcomingBookings, filter out lessons whose start time has passed
  const filteredUpcoming = upcomingBookings.filter((b: any) => {
    const tz = b.timezone || "Europe/London";
    if (b.date !== today) return true; // future date — always include
    return !hasLessonStarted(b.date, b.startTime, tz);
  });

  /* ── Build upcoming lessons array ── */
  const upcomingLessonsData = filteredUpcoming.map((b) => {
    const tutor =
      typeof b.tutorId === "object" && b.tutorId !== null
        ? (b.tutorId as any)
        : { _id: b.tutorId, firstname: "Unknown", lastname: "Tutor" };

    return {
      id: b._id.toString(),
      tutorName: `${tutor.firstname} ${tutor.lastname}`,
      tutorAvatar: tutor.profilePicture || "",
      date: b.date,
      startTime: b.startTime,
      endTime: b.endTime,
      type: b.type,
      status: b.status,
      meetingUrl: b.meetingUrl || null,
    };
  });

  /* ── Build recent messages array ── */
  const recentMessagesData = conversations.map((conv) => {
    // Find the other participant (not the student)
    const otherParticipant = (conv.participants as any[]).find(
      (p: any) => p._id.toString() !== studentId
    );

    const name = otherParticipant
      ? `${otherParticipant.firstname} ${otherParticipant.lastname}`
      : "Unknown";
    const avatar = otherParticipant?.profilePicture || "";

    // Check unread: last message was NOT sent by the student
    const isUnread =
      conv.lastMessageSenderId &&
      conv.lastMessageSenderId.toString() !== studentId;

    return {
      id: conv._id.toString(),
      senderName: name,
      senderAvatar: avatar,
      senderRole: otherParticipant?.role || "tutor",
      lastMessage: conv.lastMessage || "",
      timestamp: conv.lastMessageAt
        ? conv.lastMessageAt.toISOString()
        : conv.updatedAt.toISOString(),
      unread: !!isUnread,
    };
  });

  /* ── Build recommended tutors ── */
  // Find tutors that the student has NOT booked with, active, highly rated
  const bookedTutorIds = await Booking.distinct("tutorId", { studentId });

  const recommendedTutors = await User.find({
    role: "tutor",
    isActive: true,
    status: "active",
    _id: { $nin: bookedTutorIds },
  })
    .select(
      "firstname lastname profilePicture specializations averageRating numberOfReviews hourlyRate slug"
    )
    .sort({ averageRating: -1, numberOfReviews: -1 })
    .limit(recommendedLimit);

  // For each recommended tutor, compute next available slot label
  const recommendedTutorsData = await Promise.all(
    recommendedTutors.map(async (tutor) => {
      // Find their earliest upcoming confirmed booking to infer availability
      const nextBooking = await Booking.findOne({
        tutorId: tutor._id,
        status: { $in: ["pending", "confirmed"] },
        date: { $gte: today },
      })
        .sort({ date: 1, startTime: 1 })
        .select("date startTime");

      let nextAvailable = "Available now";
      if (nextBooking) {
        const bookingDate = new Date(nextBooking.date + "T00:00:00");
        const todayDate = new Date(today + "T00:00:00");
        const tomorrow = new Date(todayDate);
        tomorrow.setDate(tomorrow.getDate() + 1);

        if (bookingDate.toDateString() === todayDate.toDateString()) {
          nextAvailable = `Today, ${nextBooking.startTime}`;
        } else if (bookingDate.toDateString() === tomorrow.toDateString()) {
          nextAvailable = `Tomorrow, ${nextBooking.startTime}`;
        } else {
          nextAvailable = `${bookingDate.toLocaleDateString("en-GB", {
            month: "short",
            day: "numeric",
          })}, ${nextBooking.startTime}`;
        }
      }

      return {
        id: tutor._id.toString(),
        slug:
          (tutor as any).slug ||
          `${tutor.firstname}-${tutor.lastname}`
            .toLowerCase()
            .replace(/\s+/g, "-"),
        name: `${tutor.firstname} ${tutor.lastname}`,
        avatar: tutor.profilePicture || "",
        specialty: tutor.specializations?.[0] || "General English",
        rating: tutor.averageRating || 0,
        totalReviews: tutor.numberOfReviews || 0,
        hourlyRate: tutor.hourlyRate || 0,
        nextAvailable,
      };
    })
  );

  /* ── Find next lesson time for welcome banner ── */
  const nextLesson = filteredUpcoming[0] || null;

  /* ── Assemble response ── */
  return new ApiResponse(200, "Student dashboard retrieved successfully", {
    welcome: {
      firstName: student.firstname,
      hasUpcomingLesson: filteredUpcoming.length > 0,
      nextLessonTime: nextLesson
        ? `${nextLesson.date}T${nextLesson.startTime}:00`
        : null,
    },

    stats: {
      totalLessons: student.totalLessonsTaken ?? totalBookings,
      completedLessons: completedBookings,
      cancelledLessons: cancelledBookings,
      activeTutors: activeTutorIds.length,
    },

    upcomingLessons: upcomingLessonsData,

    recentMessages: recentMessagesData,

    spendingSummary: {
      totalSpent: Math.round(totalSpent * 100) / 100,
      thisMonthSpent: Math.round(thisMonthSpent * 100) / 100,
      upcomingLessonsValue: Math.round(upcomingLessonsValue * 100) / 100,
      totalHoursBooked,
    },

    learningProgress: {
      currentLevel,
      targetLevel,
      lessonsCompleted,
      totalLessonsNeeded,
      streak: student.currentStreak ?? 0,
      longestStreak: student.longestStreak ?? 0,
      hoursLearned: student.totalHoursLearned ?? 0,
    },

    recommendedTutors: recommendedTutorsData,
  });
};
