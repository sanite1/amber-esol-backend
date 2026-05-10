import { Types, Document } from "mongoose";

/* ── Subdocument interfaces ── */

export interface ICertification {
  name: string;
  issuedBy: string;
  year: string;
  documentUrl?: string;
}

export interface IEducation {
  degree: string;
  institution: string;
  year: string;
}

export interface IAddress {
  street?: string;
  city?: string;
  state?: string;
  postcode?: string;
  country: string;
}

export interface INotificationPreferences {
  email: boolean;
  push: boolean;
  sms: boolean;
  lessonReminders: boolean;
  promotions: boolean;
  newMessages: boolean;
  lessonUpdates: boolean;
  paymentAlerts: boolean;
}
export type LanguageFluency =
  | "native"
  | "fluent"
  | "advanced"
  | "intermediate"
  | "basic";

export interface Language {
  name: string;
  fluency: LanguageFluency;
}

export interface ITeachingPreferences {
  maxStudents: number;
  lessonTypes: ("one-on-one" | "group")[];
  preferredLevels: (
    | "beginner"
    | "elementary"
    | "intermediate"
    | "upper-intermediate"
    | "advanced"
  )[];
  autoAcceptBookings: boolean;
}

export interface ILearningPreferences {
  currentLevel:
    | "beginner"
    | "elementary"
    | "intermediate"
    | "upper-intermediate"
    | "advanced"
    | "proficiency";
  goals: string[];
  targetLevel?:
    | "beginner"
    | "elementary"
    | "intermediate"
    | "upper-intermediate"
    | "advanced"
    | "proficiency";
  preferredSchedule: ("morning" | "afternoon" | "evening" | "weekend")[];
  lessonTypePreference: "one-on-one" | "group" | "both";
}
export type UserStatus = "active" | "suspended" | "terminated" | "unverified";

/* ── Main User document ── */

export interface IUser extends Document {
  _id: Types.ObjectId | string;

  // Core fields (all roles)
  firstname: string;
  lastname: string;
  email: string;
  phoneNumber: string;
  password: string;
  role: "admin" | "tutor" | "student" | "org_admin";
  profilePicture?: string;
  dateOfBirth?: Date;
  gender?: "male" | "female" | "other" | "prefer-not-to-say";
  address?: IAddress;
  timezone?: string;
  bio?: string;

  // Account status
  verified: boolean;
  isActive: boolean;
  suspensionEnd?: Date;
  suspensionReason?: string;
  verificationToken?: string;
  resetToken?: string;
  resetTokenExpires?: Date;
  lastLogin?: Date;
  onlineStatus: "online" | "offline" | "away";
  lastSeen?: Date;
  status: UserStatus;

  suspendedAt: Date;
  suspendedReason?: string;

  deletionReason?: string;
  deletionFeedback?: string;
  deletedAt?: Date;

  // Tutor-specific fields
  languages?: Language[];
  nativeLanguage?: string;
  hourlyRate?: number;
  yearsOfExperience?: number;
  certifications?: ICertification[];
  education?: IEducation[];
  specializations?: string[];
  teachingPreferences?: ITeachingPreferences;
  ratings?: number[];
  averageRating?: number;
  totalLessons?: number;
  totalStudents?: number;
  numberOfReviews?: number;
  completionRate?: number;
  responseTime?: number; // in minutes
  introVideoUrl?: string;
  trialLessonOffered?: boolean;
  trialLessonPrice?: number;

  // Student-specific fields
  learningPreferences?: ILearningPreferences;
  enrolledCourses?: Types.ObjectId[];
  totalLessonsTaken?: number;
  totalHoursLearned?: number;
  currentStreak?: number;
  longestStreak?: number;

  // Notification preferences (all roles)
  notificationPreferences?: INotificationPreferences;

  // Google OAuth (for calendar integration)
  googleAccessToken?: string;
  googleRefreshToken?: string;
  tokenExpiryDate?: Date;

  // ESOL learner fields (org-managed learners only)
  orgId?: Types.ObjectId | null;
  esolLevel?: string | null;
  l1Language?: string | null;
  uln?: string | null;
  ulnStatus?: "pending" | "verified" | "not_required" | "confirmed" | null;
  fundingStatus?: "esfa_funded" | "self_funded" | "employer_funded" | "fundable" | "self_pay" | "manual_review" | null;
  esolOnboardedAt?: Date | null;

  // D1 onboarding additions (v2 spec)
  nationality?: string | null;
  ethnicity?: string | null;
  lldd_health_prob?: 1 | 2 | 9 | null;
  employment_status?: "unemployed" | "employed" | "in_training" | null;
  residency_doc_ref?: string | null;
  residency_date?: Date | null;
  ocr_confidence?: number | null;
  starting_level?: string | null;
  current_level?: string | null;
  assessment_score?: number | null;
  placement_confidence?: number | null;
  skillWeaknessFlags?: string[];

  // ESOL teacher fields (ESOL-approved tutors only)
  esolTeacherApproved?: boolean | null;
  esolQualificationType?: "CELTA" | "DELTA" | "CertTESOL" | "DipTESOL" | "PGCE" | "other" | null;
  esolQualificationUrl?: string | null;
  dbsCheckStatus?: "pending" | "clear" | "flagged" | "expired" | null;
  esolTeacherNotes?: string | null;

  // Timestamps
  createdAt: Date;
  updatedAt: Date;
}

/* ── Request body interfaces ── */

export interface ICreateStudentRequest {
  firstname: string;
  lastname: string;
  email: string;
  phoneNumber: string;
  password: string;
  profilePicture?: string;
  dateOfBirth?: string;
  gender?: string;
  address?: IAddress;
  timezone?: string;
  learningPreferences?: ILearningPreferences;
}

export interface ICreateTutorRequest {
  firstname: string;
  lastname: string;
  email: string;
  phoneNumber: string;
  password: string;
  profilePicture?: string;
  dateOfBirth?: string;
  gender?: string;
  address?: IAddress;
  timezone?: string;
  bio: string;
  languages: Language[];
  nativeLanguage: string;
  hourlyRate: number;
  yearsOfExperience: number;
  certifications: ICertification[];
  education?: IEducation[];
  specializations?: string[];
  teachingPreferences?: ITeachingPreferences;
  trialLessonOffered?: boolean;
  trialLessonPrice?: number;
  introVideoUrl?: string;
}

export interface ICreateAdminRequest {
  firstname: string;
  lastname: string;
  email: string;
  phoneNumber: string;
  password: string;
  profilePicture?: string;
}

export interface IUpdateUserRequest {
  firstname?: string;
  lastname?: string;
  phoneNumber?: string;
  profilePicture?: string;
  dateOfBirth?: string;
  gender?: string;
  address?: IAddress;
  timezone?: string;
  bio?: string;
  languages?: Language[];
  nativeLanguage?: string;
  hourlyRate?: number;
  yearsOfExperience?: number;
  certifications?: ICertification[];
  education?: IEducation[];
  specializations?: string[];
  teachingPreferences?: ITeachingPreferences;
  learningPreferences?: ILearningPreferences;
  notificationPreferences?: INotificationPreferences;
  trialLessonOffered?: boolean;
  trialLessonPrice?: number;
  introVideoUrl?: string;
}

export interface ILoginRequest {
  email: string;
  password: string;
}

export interface IRefreshTokenRequest {
  token: string;
}

export interface IForgotPasswordRequest {
  email: string;
}

export interface IResetPasswordRequest {
  password: string;
  confirmPassword: string;
}

export interface IUpdatePasswordRequest {
  oldPassword: string;
  newPassword: string;
  confirmNewPassword: string;
}

export interface IVerifyParams {
  id: Types.ObjectId;
  token: string;
}
