import { Types, Document } from "mongoose";

/* ══════════════════════════════════════════════
   FavouriteTutor
   ══════════════════════════════════════════════ */

export interface IFavouriteTutor extends Document {
  _id: Types.ObjectId;
  studentId: Types.ObjectId;
  tutorId: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

/* ══════════════════════════════════════════════
   Query interfaces
   ══════════════════════════════════════════════ */

export interface IMyTutorsQuery {
  page?: string;
  limit?: string;
  search?: string;
  filter?: string; // "all" | "active" | "past" | "favourites"
  sort?: string; // "recent" | "name" | "lessons" | "rating"
}

/* ══════════════════════════════════════════════
   Response shapes
   ══════════════════════════════════════════════ */

export interface INextLesson {
  bookingId: string;
  date: string;
  startTime: string;
  endTime: string;
  status: "pending" | "confirmed";
}

export interface IMyReview {
  reviewId: string;
  rating: number;
  comment: string;
  date: string;
}

export interface IMyTutorItem {
  id: string;
  slug: string;
  name: string;
  avatar: string | null;
  headline: string;
  specialty: string;
  languages: { name: string; fluency: string }[];
  rating: number;
  totalReviews: number;
  hourlyRate: number;
  trialRate: number;
  responseTime: string;
  timezone: string;
  totalLessonsWithMe: number;
  completedLessons: number;
  nextLesson: INextLesson | null;
  lastLessonDate: string | null;
  hasUnreadMessage: boolean;
  myReview: IMyReview | null;
  isFavourite: boolean;
  badges: string[];
}

export interface IMyTutorsSummary {
  totalTutors: number;
  activeTutors: number;
  totalLessons: number;
  favourites: number;
}

export interface IMyTutorsResponse {
  summary: IMyTutorsSummary;
  tutors: IMyTutorItem[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}
