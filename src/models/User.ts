import { Schema, model } from "mongoose";
import { IUser } from "../interfaces/user.interface";

const AddressSchema = new Schema(
  {
    street: { type: String },
    city: { type: String },
    state: { type: String },
    postcode: { type: String },
    country: { type: String, required: true },
  },
  { _id: false }
);

const CertificationSchema = new Schema(
  {
    name: { type: String, required: true },
    issuedBy: { type: String, required: true },
    year: { type: String, required: true },
    documentUrl: { type: String },
  },
  { _id: false }
);

const EducationSchema = new Schema(
  {
    degree: { type: String, required: true },
    institution: { type: String, required: true },
    year: { type: String, required: true },
  },
  { _id: false }
);

const NotificationPreferencesSchema = new Schema(
  {
    email: { type: Boolean, default: true },
    push: { type: Boolean, default: true },
    sms: { type: Boolean, default: false },
    lessonReminders: { type: Boolean, default: true },
    promotions: { type: Boolean, default: false },
    newMessages: { type: Boolean, default: true },
    lessonUpdates: { type: Boolean, default: true },
    paymentAlerts: { type: Boolean, default: true },
  },
  { _id: false }
);

const TeachingPreferencesSchema = new Schema(
  {
    maxStudents: { type: Number, default: 10 },
    lessonTypes: {
      type: [String],
      enum: ["one-on-one", "group"],
      default: ["one-on-one"],
    },
    preferredLevels: {
      type: [String],
      enum: [
        "beginner",
        "elementary",
        "intermediate",
        "upper-intermediate",
        "advanced",
      ],
      default: [],
    },
    autoAcceptBookings: { type: Boolean, default: false },
  },
  { _id: false }
);

const LearningPreferencesSchema = new Schema(
  {
    currentLevel: {
      type: String,
      enum: [
        "beginner",
        "elementary",
        "intermediate",
        "upper-intermediate",
        "advanced",
        "proficiency",
      ],
      default: "beginner",
    },
    targetLevel: {
      type: String,
      enum: [
        "beginner",
        "elementary",
        "intermediate",
        "upper-intermediate",
        "advanced",
        "proficiency",
      ],
      default: "beginner",
    },
    goals: { type: [String], default: [] },
    preferredSchedule: {
      type: [String],
      enum: ["morning", "afternoon", "evening", "weekend"],
      default: [],
    },
    lessonTypePreference: {
      type: String,
      enum: ["one-on-one", "group", "both"],
      default: "one-on-one",
    },
  },
  { _id: false }
);

// ── RARPA Stage 3 objective subdocument ─────────────────────────────────
// One per learning objective set at Stage 3 (typically 2–3 per learner per
// RARPA cycle). `id` is a stable client-supplied UUID so Stage 4 evidence
// items can reference it across edits to the objective text.
const Stage3ObjectiveSchema = new Schema(
  {
    id: { type: String, required: true },
    skill_domain: { type: String, required: true }, // Sc, Sd, Lr, Rt, Rs, Rw, Wt, Ws, Ww
    description: { type: String, required: true },
    set_at: { type: Date, default: Date.now },
    set_from: { type: String, default: null }, // e.g. "placement_assessment", "teacher_override"
    target_level: { type: String, default: null }, // e1/e2/e3/l1/l2
  },
  { _id: false }
);

const userSchema = new Schema<IUser>(
  {
    // Core fields
    firstname: { type: String, required: true, trim: true },
    lastname: { type: String, required: true, trim: true },
    email: {
      type: String,
      unique: true,
      required: true,
      lowercase: true,
      trim: true,
    },
    phoneNumber: { type: String, required: true, trim: true },
    password: { type: String, required: true },
    role: {
      type: String,
      enum: ["admin", "tutor", "student", "org_admin"],
      required: true,
    },
    profilePicture: { type: String },
    dateOfBirth: { type: Date },
    gender: {
      type: String,
      enum: ["male", "female", "other", "prefer-not-to-say"],
    },
    // ILR Sex field — numeric per ESFA spec: 1 = Male, 2 = Female. Distinct
    // from the marketplace `gender` string (which includes "other" and
    // "prefer-not-to-say") because ILR submissions accept only 1 or 2.
    // Nullable so non-ESOL users don't fail validation.
    sex: { type: Number, enum: [1, 2, null], default: null },
    address: { type: AddressSchema },
    timezone: { type: String },
    bio: { type: String },

    // Account status
    status: {
      type: String,
      enum: ["active", "suspended", "terminated", "unverified"],
      default: "unverified",
    },
    verified: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
    suspensionEnd: { type: Date, default: null },
    suspensionReason: { type: String },
    verificationToken: { type: String },
    resetToken: { type: String },
    resetTokenExpires: { type: Date },
    lastLogin: { type: Date },
    onlineStatus: {
      type: String,
      enum: ["online", "offline", "away"],
      default: "offline",
    },
    lastSeen: { type: Date },

    suspendedAt: {
      type: Date,
    },
    suspendedReason: {
      type: String,
      default: "",
    },

    deletionReason: {
      type: String,
      default: "",
    },
    deletionFeedback: {
      type: String,
      default: "",
    },
    deletedAt: {
      type: Date,
    },

    // Tutor-specific
    languages: [
      {
        name: { type: String, required: true, trim: true },
        fluency: {
          type: String,
          required: true,
          enum: ["native", "fluent", "advanced", "intermediate", "basic"],
        },
      },
    ],
    nativeLanguage: { type: String },
    hourlyRate: { type: Number },
    yearsOfExperience: { type: Number },
    certifications: { type: [CertificationSchema], default: undefined },
    education: { type: [EducationSchema], default: undefined },
    specializations: { type: [String], default: undefined },
    teachingPreferences: { type: TeachingPreferencesSchema },
    ratings: { type: [Number], default: undefined },
    averageRating: { type: Number, default: 0 },
    totalLessons: { type: Number, default: 0 },
    totalStudents: { type: Number, default: 0 },
    numberOfReviews: { type: Number, default: 0 },
    completionRate: { type: Number, default: 100 },
    responseTime: { type: Number },
    introVideoUrl: { type: String },
    trialLessonOffered: { type: Boolean },
    trialLessonPrice: { type: Number },

    // Student-specific
    learningPreferences: { type: LearningPreferencesSchema },
    enrolledCourses: [{ type: Schema.Types.ObjectId, ref: "Course" }],
    totalLessonsTaken: { type: Number, default: 0 },
    totalHoursLearned: { type: Number, default: 0 },
    currentStreak: { type: Number, default: 0 },
    longestStreak: { type: Number, default: 0 },

    // Notification preferences
    notificationPreferences: {
      type: NotificationPreferencesSchema,
      default: () => ({}),
    },

    // Google OAuth
    googleAccessToken: { type: String },
    googleRefreshToken: { type: String },
    tokenExpiryDate: { type: Date },

    // ── ESOL learner fields (existing camelCase) ──────────────────────
    // These were added before the Project Silk brief locked in snake_case
    // as the convention. They're preserved as-is to avoid breaking the
    // auth middleware, JWT payload, and the services already reading them.
    // New ESOL fields below this block use the brief's snake_case names.
    orgId: { type: Schema.Types.ObjectId, ref: "Organisation", default: null },
    esolLevel: { type: String, default: null },
    l1Language: { type: String, default: null },
    uln: { type: String, default: null },
    ulnStatus: {
      type: String,
      enum: ["pending", "verified", "not_required", "confirmed", "not_applicable", null],
      default: null,
    },
    fundingStatus: {
      type: String,
      enum: [
        "esfa_funded",
        "self_funded",
        "employer_funded",
        "fundable",
        "self_pay",
        "manual_review",
        null,
      ],
      default: null,
    },
    esolOnboardedAt: { type: Date, default: null },

    // D1 onboarding additions (v2 spec, snake_case)
    nationality: { type: String, default: null },
    ethnicity: { type: String, default: null },
    lldd_health_prob: { type: Number, enum: [1, 2, 9, null], default: null },
    employment_status: {
      type: String,
      // Brief Function 2 + ILR EmpStat values. `in_training` retained
      // for back-compat with the legacy esolOnboarding flow; the new
      // wizard and the bulk importer use the four brief-mandated
      // values.
      enum: [
        "unemployed",
        "employed",
        "self_employed",
        "not_in_labour_market",
        "in_training",
        null,
      ],
      default: null,
    },
    residency_doc_ref: { type: String, default: null },
    residency_date: { type: Date, default: null },
    ocr_confidence: { type: Number, default: null },
    starting_level: { type: String, default: null },
    current_level: { type: String, default: null },
    assessment_score: { type: Number, default: null },
    placement_confidence: { type: Number, default: null },
    skillWeaknessFlags: { type: [String], default: [] },

    // ── NEW Phase 1.6 ESOL learner fields (snake_case per brief) ──────
    postcode_prior: { type: String, default: null },
    sof_code: { type: String, default: null },
    esol_aim_type: {
      type: String,
      enum: ["regulated", "non_regulated", null],
      default: null,
    },
    /**
     * EnglishProgType code per ESFA 2025/26 ILR guidance — brief
     * Function 13 To-Do 2 §2. Used to be derivable from aim_type;
     * the 2025/26 spec made it an explicit per-learner field. Set
     * to "25" (standard ESOL provision) at import time by the bulk
     * importer + the registration wizard; ILR export reads from
     * here directly. String not number because future codes may be
     * alphanumeric (e.g. "25A").
     */
    english_prog_type: { type: String, default: null },
    esol_eligibility_declared_at: { type: Date, default: null },
    stage3_objectives: { type: [Stage3ObjectiveSchema], default: [] },
    cohort_status: {
      type: String,
      enum: ["new", "active", "inactive_mild", "inactive_moderate", "dormant"],
      default: "new",
    },
    progression_notification_sent_at: { type: Date, default: null },
    /**
     * The esolLevel the most recent progression-ready notification was
     * fired for. Function 11 dedupes notifications per (learner, level)
     * with a 7-day window — without this field, a learner who is
     * promoted to e3, struggles, and is re-flagged ready at the new
     * level would be silently skipped because the 7-day timer set at e2
     * would still be running. Storing the level alongside the timestamp
     * means a level transition resets the dedupe.
     */
    progression_notification_level: { type: String, default: null },
    /**
     * Wall-clock timestamp of the learner's last completed AI tutor
     * session. Cached on the User so the daily cohort-status sweep
     * doesn't have to project every AISession for every learner.
     * Written by the daily progression worker; the source of truth
     * stays AISession.completedAt.
     */
    last_session_at: { type: Date, default: null },

    // ── ESOL teacher fields (existing camelCase preserved) ────────────
    // Default for esolTeacherApproved changed null → false per brief: a
    // brand-new tutor explicitly is NOT approved until admin reviews them.
    esolTeacherApproved: { type: Boolean, default: false },
    esolQualificationType: {
      type: String,
      enum: ["CELTA", "DELTA", "CertTESOL", "DipTESOL", "PGCE", "other", null],
      default: null,
    },
    esolQualificationUrl: { type: String, default: null },
    dbsCheckStatus: {
      type: String,
      enum: [
        "pending",
        "clear",
        "flagged",
        "expired",
        "not_submitted",
        "cleared",
        null,
      ],
      default: null,
    },
    esolTeacherNotes: { type: String, default: null },

    // ── ESOL teacher application (brief §2 Change 2) ──────────────────
    // Captured when a tutor submits their ESOL application via
    // POST /api/esol/teachers/apply. Admin reads these to make the
    // approve/reject decision.
    dbs_check_reference: { type: String, default: null },
    esol_experience_description: { type: String, default: null },
    esol_application_submitted_at: { type: Date, default: null },
    esol_rejection_reason: { type: String, default: null },
    esol_rejected_at: { type: Date, default: null },

    // ── Addendum §4.1 teacher-multiplier fields (Phase 22) ────────────
    // Lets one ESOL teacher cover many learners with platform-computed
    // priority signals telling them where to spend their attention.
    assigned_teacher_id: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    teacher_last_reviewed_at: { type: Date, default: null },
    pathway_override: {
      // { scenario_ids: string[], set_by: ObjectId, set_at: Date }
      type: Schema.Types.Mixed,
      default: null,
    },
    glh_teacher_contact: { type: Number, default: 0 },
    teacher_priority_level: {
      type: String,
      enum: ["p1", "p2", "p3", "p4"],
      default: "p4",
    },
    teacher_recommended_action: { type: String, default: null },
    // Final Addendum §10, Todo 23.5 — stable identifier for the
    // trigger that fired. Lets the teacher UI dispatch the right
    // click handler without parsing the localised template text.
    // Same string as the top-level keys in
    // src/data/recommended-actions.json; null on legacy rows that
    // pre-date the recalc worker.
    teacher_priority_trigger_key: { type: String, default: null },
    teacher_priority_updated_at: { type: Date, default: null },
    // Final Addendum §11 — TEACHER-ONLY preference. When true (the
    // default), the re-engagement cron may auto-send a dormant-
    // learner nudge message on this teacher's behalf. Teachers
    // who prefer to write their own re-engagement notes set this
    // to false via PATCH /api/teacher/preferences/auto-re-engagement.
    // No-op for non-tutor roles.
    auto_re_engagement_enabled: { type: Boolean, default: true },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret) {
        delete ret.password;
        delete ret.__v;
        delete ret.verificationToken;
        delete ret.resetToken;
        delete ret.resetTokenExpires;
        delete ret.googleAccessToken;
        delete ret.googleRefreshToken;
        delete ret.tokenExpiryDate;
      },
    },
  }
);

// ── Compound indexes ────────────────────────────────────────────────────
// Field names match the actual Mongo field names. The codebase mixes
// camelCase (orgId, esolLevel) with snake_case (cohort_status,
// assigned_teacher_id, teacher_priority_level) — the indexes reference
// each field as it's actually stored.

// Cohort dashboard: list learners filtered by status within an org.
userSchema.index({ orgId: 1, cohort_status: 1 });

// Level-filtered cohort views.
userSchema.index({ orgId: 1, esolLevel: 1 });

// Teacher dashboard: "what should this teacher work on next?"
userSchema.index({ assigned_teacher_id: 1, teacher_priority_level: 1 });

const User = model<IUser>("User", userSchema);

export default User;
