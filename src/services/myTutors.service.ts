import { Types } from "mongoose";
import ApiError from "../errors/apiError";
import ApiResponse from "../errors/apiResponse";
import Booking from "../models/Booking";
import User from "../models/User";
import Review from "../models/Review";
import Conversation from "../models/Conversation";
import Message from "../models/Message";
import FavouriteTutor from "../models/FavouriteTutor";
import {
  IMyTutorsQuery,
  IMyTutorItem,
  INextLesson,
  IMyReview,
} from "../interfaces/myTutors.interface";

/* ══════════════════════════════════════════════
   Helper: derive tutor badges
   ══════════════════════════════════════════════ */

const deriveBadges = (tutor: any): string[] => {
  const badges: string[] = [];

  if (tutor.averageRating >= 4.8 && tutor.numberOfReviews >= 20) {
    badges.push("Top Rated");
  }
  if (tutor.responseTime && tutor.responseTime <= 60) {
    badges.push("Quick Responder");
  }
  if (tutor.totalLessons >= 200) {
    badges.push("200+ Lessons");
  } else if (tutor.totalLessons >= 100) {
    badges.push("100+ Lessons");
  }
  if (tutor.completionRate >= 98 && tutor.totalLessons >= 20) {
    badges.push("Reliable");
  }

  // Specialty-based badges
  if (tutor.specializations?.includes("IELTS Preparation")) {
    badges.push("IELTS Expert");
  }
  if (tutor.specializations?.includes("Academic English")) {
    badges.push("Academic Specialist");
  }
  if (tutor.specializations?.includes("Pronunciation")) {
    badges.push("Pronunciation Expert");
  }

  return badges.slice(0, 3); // max 3 badges
};

/* ══════════════════════════════════════════════
   Helper: format response time
   ══════════════════════════════════════════════ */

const formatResponseTime = (minutes?: number): string => {
  if (!minutes) return "N/A";
  if (minutes < 60) return `< ${minutes} min`;
  if (minutes < 120) return "< 1 hour";
  if (minutes < 180) return "< 2 hours";
  if (minutes < 1440) return `< ${Math.ceil(minutes / 60)} hours`;
  return "< 1 day";
};

/* ══════════════════════════════════════════════
   Service functions
   ══════════════════════════════════════════════ */

/* ── List My Tutors ── */

export const listMyTutorsService = async (
  studentId: string,
  query: IMyTutorsQuery
) => {
  const page = parseInt(query.page || "1", 10);
  const limit = parseInt(query.limit || "20", 10);
  const skip = (page - 1) * limit;
  const filterType = query.filter || "all";

  // 1. Find all distinct tutor IDs this student has booked with
  const tutorIdAgg = await Booking.aggregate([
    {
      $match: {
        studentId: new Types.ObjectId(studentId),
        status: {
          $nin: ["cancelled_student", "cancelled_tutor", "cancelled_admin"],
        },
      },
    },
    { $group: { _id: "$tutorId" } },
  ]);

  let allTutorIds = tutorIdAgg.map((t) => t._id as Types.ObjectId);

  if (allTutorIds.length === 0) {
    return new ApiResponse(200, "My tutors retrieved successfully", {
      summary: {
        totalTutors: 0,
        activeTutors: 0,
        totalLessons: 0,
        favourites: 0,
      },
      tutors: [],
      pagination: { page, limit, total: 0, totalPages: 0 },
    });
  }

  // 2. Fetch favourites for this student
  const favourites = await FavouriteTutor.find({
    studentId,
  })
    .select("tutorId")
    .lean();
  const favouriteSet = new Set(favourites.map((f) => f.tutorId.toString()));

  // 3. Compute per-tutor booking stats
  const bookingStats = await Booking.aggregate([
    {
      $match: {
        studentId: new Types.ObjectId(studentId),
        tutorId: { $in: allTutorIds },
        status: {
          $nin: ["cancelled_student", "cancelled_tutor", "cancelled_admin"],
        },
      },
    },
    {
      $group: {
        _id: "$tutorId",
        totalLessons: { $sum: 1 },
        completedLessons: {
          $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] },
        },
        lastCompletedDate: {
          $max: {
            $cond: [{ $eq: ["$status", "completed"] }, "$date", null],
          },
        },
        lastActivityDate: { $max: "$date" },
      },
    },
  ]);

  const statsMap = new Map<
    string,
    {
      totalLessons: number;
      completedLessons: number;
      lastCompletedDate: string | null;
      lastActivityDate: string | null;
    }
  >();
  for (const s of bookingStats) {
    statsMap.set(s._id.toString(), {
      totalLessons: s.totalLessons,
      completedLessons: s.completedLessons,
      lastCompletedDate: s.lastCompletedDate,
      lastActivityDate: s.lastActivityDate,
    });
  }

  // 4. Fetch upcoming lessons (next lesson per tutor)
  const today = new Date().toISOString().split("T")[0];
  const upcomingBookings = await Booking.find({
    studentId,
    tutorId: { $in: allTutorIds },
    status: { $in: ["pending", "confirmed"] },
    date: { $gte: today },
  })
    .sort({ date: 1, startTime: 1 })
    .lean();

  // Build map: tutorId → first upcoming lesson
  const nextLessonMap = new Map<string, INextLesson>();
  for (const b of upcomingBookings) {
    const key = b.tutorId.toString();
    if (!nextLessonMap.has(key)) {
      nextLessonMap.set(key, {
        bookingId: b._id.toString(),
        date: b.date,
        startTime: b.startTime,
        endTime: b.endTime,
        status: b.status as "pending" | "confirmed",
      });
    }
  }

  // 5. Fetch the student's reviews for these tutors
  const reviews = await Review.find({
    studentId,
    tutorId: { $in: allTutorIds },
    status: { $in: ["published", "hidden"] },
  })
    .sort({ createdAt: -1 })
    .lean();

  // Map: tutorId → most recent review by this student
  const reviewMap = new Map<string, IMyReview>();
  for (const r of reviews) {
    const key = r.tutorId.toString();
    if (!reviewMap.has(key)) {
      reviewMap.set(key, {
        reviewId: r._id.toString(),
        rating: r.rating,
        comment: r.comment,
        date: r.createdAt.toISOString(),
      });
    }
  }

  // 6. Fetch unread message status per tutor
  const conversations = await Conversation.find({
    participants: { $all: [studentId] },
  }).lean();

  // Map: otherParticipantId → conversationId
  const convMap = new Map<string, string>();
  for (const c of conversations) {
    const otherId = c.participants.find((p: any) => p.toString() !== studentId);
    if (otherId) {
      convMap.set(otherId.toString(), c._id.toString());
    }
  }

  // Check for unread messages per tutor
  const unreadMap = new Map<string, boolean>();
  for (const tutorId of allTutorIds) {
    const convId = convMap.get(tutorId.toString());
    if (convId) {
      const unreadCount = await Message.countDocuments({
        conversationId: convId,
        senderId: tutorId,
        isRead: false,
      });
      unreadMap.set(tutorId.toString(), unreadCount > 0);
    } else {
      unreadMap.set(tutorId.toString(), false);
    }
  }

  // 7. Fetch tutor user profiles
  let tutorFilter: any = {
    _id: { $in: allTutorIds },
    role: "tutor",
  };

  // Search by name/specialty
  if (query.search && query.search.trim()) {
    const searchRegex = new RegExp(query.search.trim(), "i");
    tutorFilter.$or = [
      { firstname: searchRegex },
      { lastname: searchRegex },
      { bio: searchRegex },
      { specializations: searchRegex },
    ];
  }

  const allTutors = await User.find(tutorFilter).lean();

  // 8. Build the full tutor items
  let tutorItems: IMyTutorItem[] = allTutors.map((tutor) => {
    const tid = tutor._id.toString();
    const stats = statsMap.get(tid) || {
      totalLessons: 0,
      completedLessons: 0,
      lastCompletedDate: null,
      lastActivityDate: null,
    };
    const nextLesson = nextLessonMap.get(tid) || null;
    const myReview = reviewMap.get(tid) || null;

    return {
      id: tid,
      slug: `${tutor.firstname?.toLowerCase()}-${tutor.lastname?.toLowerCase()}`,
      name: `${tutor.firstname} ${tutor.lastname}`,
      avatar: tutor.profilePicture || null,
      headline: tutor.bio || "",
      specialty: tutor.specializations?.[0] || "",
      languages: (tutor.languages || []).map((l: any) => ({
        name: l.name,
        fluency: l.fluency,
      })),
      rating: tutor.averageRating || 0,
      totalReviews: tutor.numberOfReviews || 0,
      hourlyRate: tutor.hourlyRate || 0,
      trialRate: tutor.trialLessonPrice || 0,
      responseTime: formatResponseTime(tutor.responseTime),
      timezone: tutor.timezone || "GMT+0",
      totalLessonsWithMe: stats.totalLessons,
      completedLessons: stats.completedLessons,
      nextLesson,
      lastLessonDate: stats.lastCompletedDate || null,
      hasUnreadMessage: unreadMap.get(tid) || false,
      myReview,
      isFavourite: favouriteSet.has(tid),
      badges: deriveBadges(tutor),
    };
  });

  // 9. Compute summary stats (before filtering, based on all tutors)
  const summary = {
    totalTutors: tutorItems.length,
    activeTutors: tutorItems.filter((t) => t.nextLesson !== null).length,
    totalLessons: tutorItems.reduce((sum, t) => sum + t.completedLessons, 0),
    favourites: tutorItems.filter((t) => t.isFavourite).length,
  };

  // 10. Apply filter
  switch (filterType) {
    case "active":
      tutorItems = tutorItems.filter((t) => t.nextLesson !== null);
      break;
    case "past":
      tutorItems = tutorItems.filter(
        (t) => t.nextLesson === null && t.completedLessons > 0
      );
      break;
    case "favourites":
      tutorItems = tutorItems.filter((t) => t.isFavourite);
      break;
  }

  // 11. Apply sort
  switch (query.sort || "recent") {
    case "recent":
      tutorItems.sort((a, b) => {
        const dateA = a.nextLesson?.date || a.lastLessonDate || "1970-01-01";
        const dateB = b.nextLesson?.date || b.lastLessonDate || "1970-01-01";
        return new Date(dateB).getTime() - new Date(dateA).getTime();
      });
      break;
    case "name":
      tutorItems.sort((a, b) => a.name.localeCompare(b.name));
      break;
    case "lessons":
      tutorItems.sort((a, b) => b.completedLessons - a.completedLessons);
      break;
    case "rating":
      tutorItems.sort((a, b) => b.rating - a.rating);
      break;
  }

  // 12. Paginate
  const total = tutorItems.length;
  const paginated = tutorItems.slice(skip, skip + limit);

  return new ApiResponse(200, "My tutors retrieved successfully", {
    summary,
    tutors: paginated,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  });
};

/* ── Get My Tutor Detail ── */

export const getMyTutorDetailService = async (
  studentId: string,
  tutorId: string
) => {
  // Verify this student has at least one booking with this tutor
  const hasBooking = await Booking.findOne({
    studentId,
    tutorId,
    status: {
      $nin: ["cancelled_student", "cancelled_tutor", "cancelled_admin"],
    },
  });

  if (!hasBooking) {
    throw new ApiError(404, "You have no booking history with this tutor");
  }

  const tutor = await User.findById(tutorId);
  if (!tutor || tutor.role !== "tutor") {
    throw new ApiError(404, "Tutor not found");
  }

  // Booking stats
  const bookings = await Booking.find({
    studentId,
    tutorId,
    status: {
      $nin: ["cancelled_student", "cancelled_tutor", "cancelled_admin"],
    },
  })
    .sort({ date: -1 })
    .lean();

  const completedLessons = bookings.filter(
    (b) => b.status === "completed"
  ).length;
  const lastCompleted = bookings.find((b) => b.status === "completed");

  // Next lesson
  const today = new Date().toISOString().split("T")[0];
  const upcoming = bookings.find(
    (b) =>
      (b.status === "pending" || b.status === "confirmed") && b.date >= today
  );

  const nextLesson: INextLesson | null = upcoming
    ? {
        bookingId: upcoming._id.toString(),
        date: upcoming.date,
        startTime: upcoming.startTime,
        endTime: upcoming.endTime,
        status: upcoming.status as "pending" | "confirmed",
      }
    : null;

  // Review
  const review = await Review.findOne({
    studentId,
    tutorId,
    status: { $in: ["published", "hidden"] },
  })
    .sort({ createdAt: -1 })
    .lean();

  const myReview: IMyReview | null = review
    ? {
        reviewId: review._id.toString(),
        rating: review.rating,
        comment: review.comment,
        date: review.createdAt.toISOString(),
      }
    : null;

  // Unread messages
  const conversation = await Conversation.findOne({
    participants: { $all: [studentId, tutorId] },
  }).lean();

  let hasUnreadMessage = false;
  if (conversation) {
    const unread = await Message.countDocuments({
      conversationId: conversation._id,
      senderId: tutorId,
      isRead: false,
    });
    hasUnreadMessage = unread > 0;
  }

  // Favourite
  const favourite = await FavouriteTutor.findOne({
    studentId,
    tutorId,
  }).lean();

  const item: IMyTutorItem = {
    id: tutor._id.toString(),
    slug: `${tutor.firstname?.toLowerCase()}-${tutor.lastname?.toLowerCase()}`,
    name: `${tutor.firstname} ${tutor.lastname}`,
    avatar: tutor.profilePicture || null,
    headline: tutor.bio || "",
    specialty: tutor.specializations?.[0] || "",
    languages: (tutor.languages || []).map((l: any) => ({
      name: l.name,
      fluency: l.fluency,
    })),
    rating: tutor.averageRating || 0,
    totalReviews: tutor.numberOfReviews || 0,
    hourlyRate: tutor.hourlyRate || 0,
    trialRate: tutor.trialLessonPrice || 0,
    responseTime: formatResponseTime(tutor.responseTime),
    timezone: tutor.timezone || "GMT+0",
    totalLessonsWithMe: bookings.length,
    completedLessons,
    nextLesson,
    lastLessonDate: lastCompleted?.date || null,
    hasUnreadMessage,
    myReview,
    isFavourite: !!favourite,
    badges: deriveBadges(tutor),
  };

  return new ApiResponse(200, "Tutor details retrieved successfully", item);
};

/* ── Toggle Favourite ── */

export const toggleFavouriteTutorService = async (
  studentId: string,
  tutorId: string
) => {
  // Verify tutor exists
  const tutor = await User.findById(tutorId);
  if (!tutor || tutor.role !== "tutor") {
    throw new ApiError(404, "Tutor not found");
  }

  // Check if already favourited
  const existing = await FavouriteTutor.findOne({ studentId, tutorId });

  if (existing) {
    await FavouriteTutor.findByIdAndDelete(existing._id);
    return new ApiResponse(200, "Tutor removed from favourites", {
      isFavourite: false,
    });
  }

  await FavouriteTutor.create({ studentId, tutorId });
  return new ApiResponse(200, "Tutor added to favourites", {
    isFavourite: true,
  });
};
