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

    // ESOL learner fields
    orgId: { type: Schema.Types.ObjectId, ref: "Organisation", default: null },
    esolLevel: { type: String, default: null },
    l1Language: { type: String, default: null },
    uln: { type: String, default: null },
    ulnStatus: {
      type: String,
      enum: ["pending", "verified", "not_required", null],
      default: null,
    },
    fundingStatus: {
      type: String,
      enum: ["esfa_funded", "self_funded", "employer_funded", null],
      default: null,
    },
    esolOnboardedAt: { type: Date, default: null },

    // ESOL teacher fields
    esolTeacherApproved: { type: Boolean, default: null },
    esolQualificationType: {
      type: String,
      enum: ["CELTA", "DELTA", "CertTESOL", "DipTESOL", "PGCE", "other", null],
      default: null,
    },
    esolQualificationUrl: { type: String, default: null },
    dbsCheckStatus: {
      type: String,
      enum: ["pending", "clear", "flagged", "expired", null],
      default: null,
    },
    esolTeacherNotes: { type: String, default: null },
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

const User = model<IUser>("User", userSchema);

export default User;
