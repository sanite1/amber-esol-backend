import { Types, Document } from "mongoose";

/* ── Subdocument interfaces ── */

export interface IStage3Objective {
  id: string;
  skill_domain: string;
  description: string;
  set_at: Date;
  set_from?: string | null;
  target_level?: string | null;
}

export interface IPathwayOverride {
  scenario_ids: string[];
  set_by: Types.ObjectId | string;
  set_at: Date;
}

export type CohortStatus =
  | "new"
  | "active"
  | "inactive_mild"
  | "inactive_moderate"
  | "dormant";

export type TeacherPriorityLevel = "p1" | "p2" | "p3" | "p4";

export type EsolAimType = "regulated" | "non_regulated";

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
  // ILR-compatible numeric sex (1 = Male, 2 = Female). See User.ts comment.
  sex?: 1 | 2 | null;
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

  // ESOL learner fields (org-managed learners only — existing camelCase)
  orgId?: Types.ObjectId | null;
  esolLevel?: string | null;
  l1Language?: string | null;
  uln?: string | null;
  ulnStatus?:
    | "pending"
    | "verified"
    | "not_required"
    | "confirmed"
    | "not_applicable"
    | null;
  fundingStatus?:
    | "esfa_funded"
    | "self_funded"
    | "employer_funded"
    | "fundable"
    | "self_pay"
    | "manual_review"
    | null;
  esolOnboardedAt?: Date | null;

  // D1 onboarding additions (v2 spec, snake_case)
  nationality?: string | null;
  ethnicity?: string | null;
  lldd_health_prob?: 1 | 2 | 9 | null;
  employment_status?:
    | "unemployed"
    | "employed"
    | "self_employed"
    | "not_in_labour_market"
    | "in_training"
    | null;
  residency_doc_ref?: string | null;
  residency_date?: Date | null;
  ocr_confidence?: number | null;
  starting_level?: string | null;
  current_level?: string | null;
  assessment_score?: number | null;
  placement_confidence?: number | null;
  placement_rationale?: string | null;
  skillWeaknessFlags?: string[];

  // NEW Phase 1.6 ESOL learner fields (snake_case per brief)
  postcode_prior?: string | null;
  sof_code?: string | null;
  esol_aim_type?: EsolAimType | null;
  /** ESFA 2025/26 ILR EnglishProgType code (typically "25"). */
  english_prog_type?: string | null;
  esol_eligibility_declared_at?: Date | null;
  stage3_objectives?: IStage3Objective[];
  cohort_status?: CohortStatus;
  progression_notification_sent_at?: Date | null;
  progression_notification_level?: string | null;
  last_session_at?: Date | null;

  // ESOL teacher fields (ESOL-approved tutors only — existing camelCase)
  esolTeacherApproved?: boolean;
  esolQualificationType?:
    | "CELTA"
    | "DELTA"
    | "CertTESOL"
    | "DipTESOL"
    | "PGCE"
    | "other"
    | null;
  esolQualificationUrl?: string | null;
  dbsCheckStatus?:
    | "pending"
    | "clear"
    | "flagged"
    | "expired"
    | "not_submitted"
    | "cleared"
    | null;
  esolTeacherNotes?: string | null;

  // ESOL teacher application fields (brief §2 Change 2)
  dbs_check_reference?: string | null;
  esol_experience_description?: string | null;
  esol_application_submitted_at?: Date | null;
  esol_rejection_reason?: string | null;
  esol_rejected_at?: Date | null;

  // Addendum §4.1 — teacher multiplier (Phase 22 onwards)
  assigned_teacher_id?: Types.ObjectId | null;
  teacher_last_reviewed_at?: Date | null;
  pathway_override?: IPathwayOverride | null;
  glh_teacher_contact?: number;
  teacher_priority_level?: TeacherPriorityLevel;
  teacher_recommended_action?: string | null;
  /**
   * Final Addendum §10, Todo 23.5 — stable trigger identifier so
   * the teacher UI can dispatch the right click handler without
   * parsing the localised text. Mirrors `PriorityTriggerKey` from
   * priorityQueue.service.ts. Null on rows written before the
   * recalc worker shipped.
   */
  teacher_priority_trigger_key?: string | null;
  teacher_priority_updated_at?: Date | null;
  /**
   * Final Addendum §11 — teacher-only preference. When true (the
   * default), the daily re-engagement cron may auto-send dormant-
   * learner messages from this teacher. Surfaced as a toggle on
   * the teacher dashboard; PATCH'd via
   * `/api/teacher/preferences/auto-re-engagement`.
   */
  auto_re_engagement_enabled?: boolean;

  /**
   * Teacher-only. Needs-based matching profile — level coverage,
   * spoken languages, specialisms. Empty arrays = unspecified (the
   * teacher stays eligible for everything). See
   * teacherMatching.service.ts.
   */
  teaching_profile?: {
    levels_taught: string[];
    languages_spoken: string[];
    specialisms: string[];
  };

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
