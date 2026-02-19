import { Types } from "mongoose";
import ApiError from "../errors/apiError";
import ApiResponse from "../errors/apiResponse";
import Booking from "../models/Booking";
import Review from "../models/Review";
import User from "../models/User";
import Message from "../models/Message";
import Conversation from "../models/Conversation";
import {
  IMyStudentsQuery,
  IMyStudentItem,
  IMyStudentsStats,
  IStudentLesson,
} from "../interfaces/myStudents.interface";
import TutorStudentNote from "../models/TutorStudentNote";

/* ══════════════════════════════════════════════
   Helper: determine student status relative to tutor
   ══════════════════════════════════════════════ */
const INACTIVE_DAYS = 30; // no lesson in 30 days → inactive

function determineStatus(
  bookings: any[],
  hasUpcoming: boolean
): "active" | "inactive" | "trial" {
  const completed = bookings.filter((b: any) => b.status === "completed");
  const trials = completed.filter((b: any) => b.type === "trial");

  // Only trial lessons ever completed, no upcoming regular
  if (
    completed.length > 0 &&
    completed.length === trials.length &&
    !hasUpcoming
  ) {
    return "trial";
  }

  if (hasUpcoming) return "active";

  // Check recency of last completed
  const lastCompleted = completed.sort(
    (a: any, b: any) =>
      new Date(`${b.date}T${b.endTime}`).getTime() -
      new Date(`${a.date}T${a.endTime}`).getTime()
  )[0];

  if (lastCompleted) {
    const daysSince = Math.floor(
      (Date.now() -
        new Date(`${lastCompleted.date}T${lastCompleted.endTime}`).getTime()) /
        86400000
    );
    if (daysSince <= INACTIVE_DAYS) return "active";
  }

  return "inactive";
}

/* ══════════════════════════════════════════════
   Helper: build one IMyStudentItem
   ══════════════════════════════════════════════ */
async function buildStudentItem(
  tutorId: string,
  studentUser: any,
  allBookings: any[]
): Promise<IMyStudentItem> {
  const studentId = studentUser._id.toString();

  // Bookings for this specific student
  const bookings = allBookings.filter(
    (b: any) => b.studentId.toString() === studentId
  );

  const completed = bookings.filter((b: any) => b.status === "completed");
  const cancelled = bookings.filter((b: any) =>
    ["cancelled_student", "cancelled_tutor", "cancelled_admin"].includes(
      b.status
    )
  );
  const noShows = bookings.filter((b: any) => b.status === "no_show");

  // Upcoming (confirmed or pending, date >= today)
  const todayStr = new Date().toISOString().split("T")[0];
  const upcoming = bookings
    .filter(
      (b: any) =>
        ["pending", "confirmed"].includes(b.status) && b.date >= todayStr
    )
    .sort((a: any, b: any) => a.date.localeCompare(b.date));

  // Total hours
  const totalMinutes = completed.reduce((sum: number, b: any) => {
    const [sH, sM] = b.startTime.split(":").map(Number);
    const [eH, eM] = b.endTime.split(":").map(Number);
    return sum + (eH * 60 + eM - (sH * 60 + sM));
  }, 0);

  // Total spent
  const totalSpent = completed.reduce(
    (sum: number, b: any) => sum + (b.price || 0),
    0
  );

  // Average rating: reviews this student left for this tutor
  const reviews = await Review.find({
    studentId: new Types.ObjectId(studentId),
    tutorId: new Types.ObjectId(tutorId),
    status: "published",
  }).lean();

  const avgRating =
    reviews.length > 0
      ? Math.round(
          (reviews.reduce((s: number, r: any) => s + r.rating, 0) /
            reviews.length) *
            10
        ) / 10
      : undefined;

  // Last lesson date
  const lastCompleted = completed.sort((a: any, b: any) =>
    b.date.localeCompare(a.date)
  )[0];

  // Recent lessons (last 4)
  const recentBookings = bookings
    .sort(
      (a: any, b: any) =>
        new Date(`${b.date}T${b.startTime}`).getTime() -
        new Date(`${a.date}T${a.startTime}`).getTime()
    )
    .slice(0, 4);

  const recentLessons: IStudentLesson[] = recentBookings.map((b: any) => {
    const [sH, sM] = b.startTime.split(":").map(Number);
    const [eH, eM] = b.endTime.split(":").map(Number);
    const duration = eH * 60 + eM - (sH * 60 + sM);

    let lessonStatus: IStudentLesson["status"] = "completed";
    if (b.status === "completed") lessonStatus = "completed";
    else if (["pending", "confirmed"].includes(b.status) && b.date >= todayStr)
      lessonStatus = "upcoming";
    else if (b.status === "no_show") lessonStatus = "no_show";
    else if (b.status.startsWith("cancelled")) lessonStatus = "cancelled";

    return {
      id: b._id.toString(),
      date: new Date(`${b.date}T${b.startTime}`).toISOString(),
      type: b.type,
      status: lessonStatus,
      duration,
      topic: b.specialty || undefined,
    };
  });

  // First booking date with this tutor → "joined"
  const firstBooking = bookings.sort((a: any, b: any) =>
    a.createdAt > b.createdAt ? 1 : -1
  )[0];

  const hasUpcoming = upcoming.length > 0;
  const status = determineStatus(bookings, hasUpcoming);

  // Student goals from learningPreferences
  const goals = studentUser.learningPreferences?.goals || [];

  // Country from address
  const country = studentUser.address?.country || "";
  // Country code: first 2 chars uppercase or ""
  const countryCode = country ? country.slice(0, 2).toUpperCase() : "";

  // Level
  const level =
    studentUser.learningPreferences?.currentLevel?.toUpperCase() || "";

  // Languages
  const languages = studentUser.languages
    ? studentUser.languages.map((l: any) => l.name)
    : [];

  return {
    id: studentId,
    name: `${studentUser.firstname} ${studentUser.lastname}`,
    avatar: studentUser.profilePicture || undefined,
    email: studentUser.email,
    country,
    countryCode,
    level,
    languages,
    joinedDate: firstBooking
      ? new Date(firstBooking.createdAt).toISOString().split("T")[0]
      : studentUser.createdAt.toISOString().split("T")[0],
    lastLessonDate: lastCompleted
      ? lastCompleted.date
      : firstBooking
        ? firstBooking.date
        : studentUser.createdAt.toISOString().split("T")[0],
    nextLessonDate: upcoming[0]?.date || undefined,
    totalLessons: bookings.length,
    completedLessons: completed.length,
    cancelledLessons: cancelled.length,
    noShows: noShows.length,
    totalHours: Math.round((totalMinutes / 60) * 10) / 10,
    totalSpent,
    averageRating: avgRating,
    status,
    notes: undefined, // populated from TutorStudentNote if model exists
    recentLessons,
    goals: goals.length > 0 ? goals : undefined,
  };
}

/* ══════════════════════════════════════════════
   GET /my-students  — list
   ══════════════════════════════════════════════ */
export const listMyStudentsService = async (
  tutorId: string,
  query: IMyStudentsQuery
) => {
  const page = parseInt(query.page || "1", 10);
  const limit = parseInt(query.limit || "20", 10);

  // 1. Find all bookings for this tutor
  const allBookings = await Booking.find({
    tutorId: new Types.ObjectId(tutorId),
  }).lean();

  // 2. Get unique student IDs
  const studentIdSet = new Set<string>();
  for (const b of allBookings) {
    studentIdSet.add(b.studentId.toString());
  }
  const studentIds = Array.from(studentIdSet);

  if (studentIds.length === 0) {
    const emptyStats: IMyStudentsStats = {
      totalStudents: 0,
      activeStudents: 0,
      trialStudents: 0,
      inactiveStudents: 0,
      avgLessonsPerStudent: 0,
      totalRevenue: 0,
      retentionRate: 0,
    };
    return new ApiResponse(200, "Students retrieved successfully", {
      students: [],
      stats: emptyStats,
      pagination: { page, limit, total: 0, pages: 0 },
    });
  }

  // 3. Fetch student user docs
  const studentFilter: any = {
    _id: { $in: studentIds.map((id) => new Types.ObjectId(id)) },
  };

  // Search by name / email / country
  if (query.search && query.search.trim()) {
    const q = query.search.trim();
    const regex = new RegExp(q, "i");
    studentFilter.$or = [
      { firstname: regex },
      { lastname: regex },
      { email: regex },
      { "address.country": regex },
    ];
  }

  const studentUsers = await User.find(studentFilter).lean();

  // 4. Build items
  const itemPromises = studentUsers.map((su) =>
    buildStudentItem(tutorId, su, allBookings)
  );
  let students = await Promise.all(itemPromises);

  // 5. Compute stats (before filtering)
  const totalStudents = students.length;
  const activeStudents = students.filter((s) => s.status === "active").length;
  const trialStudents = students.filter((s) => s.status === "trial").length;
  const inactiveStudents = students.filter(
    (s) => s.status === "inactive"
  ).length;
  const avgLessonsPerStudent =
    totalStudents > 0
      ? Math.round(
          (students.reduce((s, st) => s + st.completedLessons, 0) /
            totalStudents) *
            10
        ) / 10
      : 0;
  const totalRevenue = students.reduce((s, st) => s + st.totalSpent, 0);
  // Retention: students who came back after first lesson (completedLessons > 1) / total who completed at least 1
  const studentsWithLessons = students.filter(
    (s) => s.completedLessons >= 1
  ).length;
  const returnedStudents = students.filter(
    (s) => s.completedLessons > 1
  ).length;
  const retentionRate =
    studentsWithLessons > 0
      ? Math.round((returnedStudents / studentsWithLessons) * 100)
      : 0;

  const stats: IMyStudentsStats = {
    totalStudents,
    activeStudents,
    trialStudents,
    inactiveStudents,
    avgLessonsPerStudent,
    totalRevenue,
    retentionRate,
  };

  // 6. Filter by status
  if (query.filter && query.filter !== "all") {
    students = students.filter((s) => s.status === query.filter);
  }

  // 7. Sort
  switch (query.sort) {
    case "name":
      students.sort((a, b) => a.name.localeCompare(b.name));
      break;
    case "lessons":
      students.sort((a, b) => b.completedLessons - a.completedLessons);
      break;
    case "joined":
      students.sort(
        (a, b) =>
          new Date(b.joinedDate).getTime() - new Date(a.joinedDate).getTime()
      );
      break;
    case "recent":
    default:
      students.sort(
        (a, b) =>
          new Date(b.lastLessonDate).getTime() -
          new Date(a.lastLessonDate).getTime()
      );
      break;
  }

  // 8. Paginate
  const total = students.length;
  const pages = Math.ceil(total / limit);
  const paginated = students.slice((page - 1) * limit, page * limit);

  return new ApiResponse(200, "Students retrieved successfully", {
    students: paginated,
    stats,
    pagination: { page, limit, total, pages },
  });
};

/* ══════════════════════════════════════════════
   GET /my-students/:studentId  — detail
   ══════════════════════════════════════════════ */
export const getMyStudentDetailService = async (
  tutorId: string,
  studentId: string
) => {
  // Verify this student has bookings with this tutor
  const bookingExists = await Booking.findOne({
    tutorId: new Types.ObjectId(tutorId),
    studentId: new Types.ObjectId(studentId),
  }).lean();

  if (!bookingExists) {
    throw new ApiError(404, "Student not found in your roster");
  }

  const studentUser = await User.findById(studentId).lean();
  if (!studentUser) {
    throw new ApiError(404, "Student not found");
  }

  const allBookings = await Booking.find({
    tutorId: new Types.ObjectId(tutorId),
    studentId: new Types.ObjectId(studentId),
  }).lean();

  const student = await buildStudentItem(tutorId, studentUser, allBookings);

  return new ApiResponse(200, "Student detail retrieved successfully", {
    student,
  });
};

/* ══════════════════════════════════════════════
   PATCH /my-students/:studentId/notes  — update notes
   ══════════════════════════════════════════════ */
export const updateStudentNotesService = async (
  tutorId: string,
  studentId: string,
  notes: string
) => {
  // Verify relationship exists
  const bookingExists = await Booking.findOne({
    tutorId: new Types.ObjectId(tutorId),
    studentId: new Types.ObjectId(studentId),
  }).lean();

  if (!bookingExists) {
    throw new ApiError(404, "Student not found in your roster");
  }

  // Upsert into TutorStudentNote

  const note = await TutorStudentNote.findOneAndUpdate(
    {
      tutorId: new Types.ObjectId(tutorId),
      studentId: new Types.ObjectId(studentId),
    },
    { notes },
    { upsert: true, new: true }
  );

  return new ApiResponse(200, "Notes updated successfully", {
    notes: note.notes,
  });
};
