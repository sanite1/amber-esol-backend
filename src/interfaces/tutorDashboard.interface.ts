/* ──────────────────────────────────────────────
   Tutor Dashboard interfaces
   ────────────────────────────────────────────── */

export interface ITutorDashboardQuery {
  upcomingLimit?: string;
  messagesLimit?: string;
}

/* ── Welcome Banner ── */

export interface IDashboardWelcome {
  firstName: string;
  avatarUrl: string;
  isOnline: boolean;
  todayLessons: number;
  nextLessonTime: string | null;
  averageRating: number;
  totalStudents: number;
}

/* ── Stats Row ── */

export interface IDashboardStats {
  totalLessons: number;
  totalStudents: number;
  averageRating: number;
  completionRate: number;
}

/* ── Upcoming Lesson ── */

export interface IDashboardUpcomingLesson {
  id: string;
  studentName: string;
  studentAvatar: string;
  studentLevel: string;
  lessonType: "trial" | "regular";
  status: string;
  specialty: string;
  date: string;
  startTime: string;
  endTime: string;
  meetingUrl: string | null;
  notes: string | null;
}

/* ── Pending Booking ── */

export interface IDashboardPendingBooking {
  id: string;
  studentName: string;
  studentAvatar: string;
  studentLevel: string;
  lessonType: "trial" | "regular";
  hoursRequested: number;
  totalAmount: number;
  requestedDate: string;
  message: string | null;
}

/* ── Earnings ── */

export interface IDashboardEarnings {
  thisMonthEarnings: number;
  lastMonthEarnings: number;
  totalEarnings: number;
  pendingPayout: number;
  nextPayoutDate: string | null;
  completedLessonsThisMonth: number;
}

/* ── Availability ── */

export interface IDashboardAvailability {
  totalSlotsThisWeek: number;
  bookedSlotsThisWeek: number;
  nextAvailableSlot: string | null;
}

/* ── Performance ── */

export interface IDashboardPerformance {
  averageRating: number;
  responseRate: number;
  completionRate: number;
  repeatStudentRate: number;
  numberOfReviews: number;
  totalLessons: number;
}

/* ── Recent Message ── */

export interface IDashboardRecentMessage {
  id: string;
  studentName: string;
  studentAvatar: string;
  lastMessage: string;
  timestamp: string;
  unread: boolean;
}

/* ── Full Response ── */

export interface ITutorDashboardResponse {
  message: string;
  data: {
    welcome: IDashboardWelcome;
    stats: IDashboardStats;
    upcomingLessons: IDashboardUpcomingLesson[];
    pendingBookings: IDashboardPendingBooking[];
    earnings: IDashboardEarnings;
    availability: IDashboardAvailability;
    performance: IDashboardPerformance;
    recentMessages: IDashboardRecentMessage[];
  };
}
