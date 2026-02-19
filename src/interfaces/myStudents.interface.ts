import { Types } from "mongoose";

/* ══════════════════════════════════════════════
   Enums / Unions
   ══════════════════════════════════════════════ */

export type StudentStatusFilter = "all" | "active" | "trial" | "inactive";
export type StudentSortOption = "recent" | "name" | "lessons" | "joined";

/* ══════════════════════════════════════════════
   Subdocuments
   ══════════════════════════════════════════════ */

export interface IStudentLesson {
  id: string;
  date: string;
  type: "trial" | "regular";
  status: "completed" | "upcoming" | "cancelled" | "no_show";
  duration: number;
  topic?: string;
}

/* ══════════════════════════════════════════════
   Main student item (API response shape)
   ══════════════════════════════════════════════ */

export interface IMyStudentItem {
  id: string;
  name: string;
  avatar?: string;
  email: string;
  country: string;
  countryCode: string;
  level: string;
  languages: string[];
  joinedDate: string;
  lastLessonDate: string;
  nextLessonDate?: string;
  totalLessons: number;
  completedLessons: number;
  cancelledLessons: number;
  noShows: number;
  totalHours: number;
  totalSpent: number;
  averageRating?: number;
  status: "active" | "inactive" | "trial";
  notes?: string;
  recentLessons: IStudentLesson[];
  goals?: string[];
}

/* ══════════════════════════════════════════════
   Stats
   ══════════════════════════════════════════════ */

export interface IMyStudentsStats {
  totalStudents: number;
  activeStudents: number;
  trialStudents: number;
  inactiveStudents: number;
  avgLessonsPerStudent: number;
  totalRevenue: number;
  retentionRate: number;
}

/* ══════════════════════════════════════════════
   Query interface
   ══════════════════════════════════════════════ */

export interface IMyStudentsQuery {
  page?: string;
  limit?: string;
  filter?: string; // "all" | "active" | "trial" | "inactive"
  sort?: string; // "recent" | "name" | "lessons" | "joined"
  search?: string;
}

/* ══════════════════════════════════════════════
   Response shapes
   ══════════════════════════════════════════════ */

export interface IMyStudentsResponse {
  students: IMyStudentItem[];
  stats: IMyStudentsStats;
  pagination: {
    page: number;
    limit: number;
    total: number;
    pages: number;
  };
}

export interface IMyStudentDetailResponse {
  student: IMyStudentItem;
}

/* ══════════════════════════════════════════════
   Add / Update notes
   ══════════════════════════════════════════════ */

export interface IUpdateStudentNotesRequest {
  notes: string;
}
