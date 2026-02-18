// src/validations/user.validation.ts
import { NextFunction, Request, Response } from "express";
import { Joi, validate } from "express-validation";
import { Types } from "mongoose";

/* ── Helper: parse JSON fields from multipart form-data ── */

export function parseJsonFields(
  req: Request,
  _res: Response,
  next: NextFunction
) {
  try {
    const jsonFields = [
      "languages",
      "certifications",
      "education",
      "specializations",
      "address",
      "teachingPreferences",
      "learningPreferences",
      "notificationPreferences",
      "goals",
      "preferredSchedule",
    ];
    for (const field of jsonFields) {
      if (typeof req.body[field] === "string") {
        req.body[field] = JSON.parse(req.body[field]);
      }
    }
    next();
  } catch (error) {
    return next(error);
  }
}

/* ── Helper: ObjectId validator ── */

const objectId = Joi.string()
  .custom((value, helpers) => {
    if (!Types.ObjectId.isValid(value)) {
      return helpers.error("any.invalid");
    }
    return value;
  }, "ObjectId validation")
  .messages({
    "any.invalid": "{{#label}} must be a valid ID",
    "string.base": "{{#label}} must be a string",
    "any.required": "{{#label}} is required",
  });

/* ── Reusable sub-schemas ── */

const addressSchema = Joi.object({
  street: Joi.string().optional().allow("").messages({
    "string.base": "Street must be a string",
  }),
  city: Joi.string().optional().allow("").messages({
    "string.base": "City must be a string",
  }),
  state: Joi.string().optional().allow("").messages({
    "string.base": "State must be a string",
  }),
  postcode: Joi.string().optional().allow("").messages({
    "string.base": "Postcode must be a string",
  }),
  country: Joi.string().required().messages({
    "string.base": "Country must be a string",
    "string.empty": "Country is required",
    "any.required": "Country is required",
  }),
})
  .unknown(false)
  .messages({
    "object.unknown": "{{#label}} is not a recognised address field",
  });

const languageObject = Joi.object({
  name: Joi.string().trim().required().messages({
    "string.empty": "Language name is required",
    "any.required": "Language name is required",
  }),
  fluency: Joi.string()
    .valid("native", "fluent", "advanced", "intermediate", "basic")
    .required()
    .messages({
      "any.only":
        "Fluency must be one of: native, fluent, advanced, intermediate, basic",
      "any.required": "Fluency level is required",
    }),
});

const certificationSchema = Joi.object({
  name: Joi.string().required().messages({
    "string.base": "Certification name must be a string",
    "string.empty": "Certification name is required",
    "any.required": "Certification name is required",
  }),
  issuedBy: Joi.string().required().messages({
    "string.base": "Issuing body must be a string",
    "string.empty": "Issuing body is required",
    "any.required": "Issuing body is required",
  }),
  year: Joi.string().required().messages({
    "string.base": "Certification year must be a string",
    "string.empty": "Certification year is required",
    "any.required": "Certification year is required",
  }),
  documentUrl: Joi.string().uri().optional().allow("").messages({
    "string.base": "Document URL must be a string",
    "string.uri": "Document URL must be a valid URL",
  }),
})
  .unknown(false)
  .messages({
    "object.unknown": "{{#label}} is not a recognised certification field",
  });

const educationSchema = Joi.object({
  degree: Joi.string().required().messages({
    "string.base": "Degree must be a string",
    "string.empty": "Degree is required",
    "any.required": "Degree is required",
  }),
  institution: Joi.string().required().messages({
    "string.base": "Institution must be a string",
    "string.empty": "Institution is required",
    "any.required": "Institution is required",
  }),
  year: Joi.string().required().messages({
    "string.base": "Education year must be a string",
    "string.empty": "Education year is required",
    "any.required": "Education year is required",
  }),
})
  .unknown(false)
  .messages({
    "object.unknown": "{{#label}} is not a recognised education field",
  });

const teachingPreferencesSchema = Joi.object({
  maxStudents: Joi.number().min(1).max(50).optional().messages({
    "number.base": "Max students must be a number",
    "number.min": "Max students must be at least 1",
    "number.max": "Max students cannot exceed 50",
  }),
  lessonTypes: Joi.array()
    .items(
      Joi.string().valid("one-on-one", "group").messages({
        "any.only": 'Each lesson type must be either "one-on-one" or "group"',
      })
    )
    .optional()
    .messages({
      "array.base": "Lesson types must be an array",
    }),
  preferredLevels: Joi.array()
    .items(
      Joi.string()
        .valid(
          "beginner",
          "elementary",
          "intermediate",
          "upper-intermediate",
          "advanced"
        )
        .messages({
          "any.only":
            "Each level must be one of: beginner, elementary, intermediate, upper-intermediate, advanced",
        })
    )
    .optional()
    .messages({
      "array.base": "Preferred levels must be an array",
    }),
  autoAcceptBookings: Joi.boolean().optional().messages({
    "boolean.base": "Auto-accept bookings must be true or false",
  }),
})
  .unknown(false)
  .messages({
    "object.unknown":
      "{{#label}} is not a recognised teaching preference field",
  });

const learningPreferencesSchema = Joi.object({
  currentLevel: Joi.string()
    .valid(
      "beginner",
      "elementary",
      "intermediate",
      "upper-intermediate",
      "advanced",
      "proficiency"
    )
    .optional()
    .messages({
      "string.base": "Current level must be a string",
      "any.only":
        "Current level must be one of: beginner, elementary, intermediate, upper-intermediate, advanced, proficiency",
    }),
  targetLevel: Joi.string()
    .valid(
      "beginner",
      "elementary",
      "intermediate",
      "upper-intermediate",
      "advanced",
      "proficiency"
    )
    .optional()
    .messages({
      "string.base": "Target level must be a string",
      "any.only":
        "Target level must be one of: beginner, elementary, intermediate, upper-intermediate, advanced, proficiency",
    }),
  goals: Joi.array()
    .items(
      Joi.string().messages({
        "string.base": "Each goal must be a string",
      })
    )
    .optional()
    .messages({
      "array.base": "Goals must be an array",
    }),
  preferredSchedule: Joi.array()
    .items(
      Joi.string()
        .valid("morning", "afternoon", "evening", "weekend")
        .messages({
          "any.only":
            "Each schedule slot must be one of: morning, afternoon, evening, weekend",
        })
    )
    .optional()
    .messages({
      "array.base": "Preferred schedule must be an array",
    }),
  lessonTypePreference: Joi.string()
    .valid("one-on-one", "group", "both")
    .optional()
    .messages({
      "string.base": "Lesson type preference must be a string",
      "any.only":
        "Lesson type preference must be one of: one-on-one, group, both",
    }),
})
  .unknown(false)
  .messages({
    "object.unknown":
      "{{#label}} is not a recognised learning preference field",
  });

const notificationPreferencesSchema = Joi.object({
  email: Joi.boolean().optional().messages({
    "boolean.base": "Email notification preference must be true or false",
  }),
  push: Joi.boolean().optional().messages({
    "boolean.base": "Push notification preference must be true or false",
  }),
  sms: Joi.boolean().optional().messages({
    "boolean.base": "SMS notification preference must be true or false",
  }),
  lessonReminders: Joi.boolean().optional().messages({
    "boolean.base": "Lesson reminders preference must be true or false",
  }),
  promotions: Joi.boolean().optional().messages({
    "boolean.base": "Promotions preference must be true or false",
  }),
  newMessages: Joi.boolean().optional().messages({
    "boolean.base": "New messages preference must be true or false",
  }),
  lessonUpdates: Joi.boolean().optional().messages({
    "boolean.base": "Lesson updates preference must be true or false",
  }),
  paymentAlerts: Joi.boolean().optional().messages({
    "boolean.base": "Payment alerts preference must be true or false",
  }),
})
  .unknown(false)
  .messages({
    "object.unknown":
      "{{#label}} is not a recognised notification preference field",
  });

/* ══════════════════════════════════════════════
   Main schemas
   ══════════════════════════════════════════════ */

/* ── Register Student ── */

const registerStudentSchema = {
  body: Joi.object({
    firstname: Joi.string().min(2).required().messages({
      "string.base": "First name must be a string",
      "string.empty": "First name is required",
      "string.min": "First name must be at least 2 characters",
      "any.required": "First name is required",
    }),
    lastname: Joi.string().min(2).required().messages({
      "string.base": "Last name must be a string",
      "string.empty": "Last name is required",
      "string.min": "Last name must be at least 2 characters",
      "any.required": "Last name is required",
    }),
    email: Joi.string().email().required().messages({
      "string.base": "Email must be a string",
      "string.empty": "Email is required",
      "string.email": "Please enter a valid email address",
      "any.required": "Email is required",
    }),
    phoneNumber: Joi.string().required().messages({
      "string.base": "Phone number must be a string",
      "string.empty": "Phone number is required",
      "any.required": "Phone number is required",
    }),
    password: Joi.string().min(8).required().messages({
      "string.base": "Password must be a string",
      "string.empty": "Password is required",
      "string.min": "Password must be at least 8 characters",
      "any.required": "Password is required",
    }),
    profilePicture: Joi.string().uri().allow("").optional().messages({
      "string.base": "Profile picture must be a string",
      "string.uri": "Profile picture must be a valid URL",
    }),
    dateOfBirth: Joi.string().optional().messages({
      "string.base": "Date of birth must be a string",
    }),
    gender: Joi.string()
      .valid("male", "female", "other", "prefer-not-to-say")
      .optional()
      .messages({
        "string.base": "Gender must be a string",
        "any.only":
          "Gender must be one of: male, female, other, prefer-not-to-say",
      }),
    address: addressSchema.optional(),
    timezone: Joi.string().optional().messages({
      "string.base": "Timezone must be a string",
    }),
    nativeLanguage: Joi.string().optional().messages({
      "string.base": "Native language must be a string",
    }),
    learningPreferences: learningPreferencesSchema.optional(),
  })
    .unknown(false)
    .messages({
      "object.unknown":
        'Field "{{#label}}" is not allowed for student registration',
    }),
};

/* ── Register Tutor ── */

const registerTutorSchema = {
  body: Joi.object({
    firstname: Joi.string().min(2).required().messages({
      "string.base": "First name must be a string",
      "string.empty": "First name is required",
      "string.min": "First name must be at least 2 characters",
      "any.required": "First name is required",
    }),
    lastname: Joi.string().min(2).required().messages({
      "string.base": "Last name must be a string",
      "string.empty": "Last name is required",
      "string.min": "Last name must be at least 2 characters",
      "any.required": "Last name is required",
    }),
    email: Joi.string().email().required().messages({
      "string.base": "Email must be a string",
      "string.empty": "Email is required",
      "string.email": "Please enter a valid email address",
      "any.required": "Email is required",
    }),
    phoneNumber: Joi.string().required().messages({
      "string.base": "Phone number must be a string",
      "string.empty": "Phone number is required",
      "any.required": "Phone number is required",
    }),
    password: Joi.string().min(8).required().messages({
      "string.base": "Password must be a string",
      "string.empty": "Password is required",
      "string.min": "Password must be at least 8 characters",
      "any.required": "Password is required",
    }),
    profilePicture: Joi.string().uri().optional().messages({
      "string.base": "Profile picture must be a string",
      "string.uri": "Profile picture must be a valid URL",
    }),
    dateOfBirth: Joi.string().optional().messages({
      "string.base": "Date of birth must be a string",
    }),
    gender: Joi.string()
      .valid("male", "female", "other", "prefer-not-to-say")
      .optional()
      .messages({
        "string.base": "Gender must be a string",
        "any.only":
          "Gender must be one of: male, female, other, prefer-not-to-say",
      }),
    address: addressSchema.optional(),
    timezone: Joi.string().optional().messages({
      "string.base": "Timezone must be a string",
    }),
    bio: Joi.string().required().messages({
      "string.base": "Bio must be a string",
      "string.empty": "Bio is required",
      "any.required": "Bio is required",
    }),
    languages: Joi.array().items(languageObject).min(1).required().messages({
      "array.base": "Languages must be an array",
      "array.min": "At least one language is required",
      "any.required": "Languages are required",
    }),
    nativeLanguage: Joi.string().required().messages({
      "string.base": "Native language must be a string",
      "string.empty": "Native language is required",
      "any.required": "Native language is required",
    }),
    hourlyRate: Joi.number().min(0).required().messages({
      "number.base": "Hourly rate must be a number",
      "number.min": "Hourly rate cannot be negative",
      "any.required": "Hourly rate is required",
    }),
    yearsOfExperience: Joi.number().min(0).required().messages({
      "number.base": "Years of experience must be a number",
      "number.min": "Years of experience cannot be negative",
      "any.required": "Years of experience is required",
    }),
    certifications: Joi.array()
      .items(certificationSchema)
      .min(1)
      .required()
      .messages({
        "array.base": "Certifications must be an array",
        "array.min": "At least one certification is required",
        "any.required": "Certifications are required",
      }),
    education: Joi.array().items(educationSchema).optional().messages({
      "array.base": "Education must be an array",
    }),
    specializations: Joi.array()
      .items(
        Joi.string().messages({
          "string.base": "Each specialization must be a string",
        })
      )
      .optional()
      .messages({
        "array.base": "Specializations must be an array",
      }),
    teachingPreferences: teachingPreferencesSchema.optional(),
    trialLessonOffered: Joi.boolean().optional().messages({
      "boolean.base": "Trial lesson offered must be true or false",
    }),
    trialLessonPrice: Joi.number().min(0).optional().messages({
      "number.base": "Trial lesson price must be a number",
      "number.min": "Trial lesson price cannot be negative",
    }),
    introVideoUrl: Joi.string().uri().optional().allow("").messages({
      "string.base": "Intro video URL must be a string",
      "string.uri": "Intro video URL must be a valid URL",
    }),
  })
    .unknown(false)
    .messages({
      "object.unknown":
        'Field "{{#label}}" is not allowed for tutor registration',
    }),
};

/* ── Register Admin ── */

const registerAdminSchema = {
  body: Joi.object({
    firstname: Joi.string().min(2).required().messages({
      "string.base": "First name must be a string",
      "string.empty": "First name is required",
      "string.min": "First name must be at least 2 characters",
      "any.required": "First name is required",
    }),
    lastname: Joi.string().min(2).required().messages({
      "string.base": "Last name must be a string",
      "string.empty": "Last name is required",
      "string.min": "Last name must be at least 2 characters",
      "any.required": "Last name is required",
    }),
    email: Joi.string().email().required().messages({
      "string.base": "Email must be a string",
      "string.empty": "Email is required",
      "string.email": "Please enter a valid email address",
      "any.required": "Email is required",
    }),
    phoneNumber: Joi.string().required().messages({
      "string.base": "Phone number must be a string",
      "string.empty": "Phone number is required",
      "any.required": "Phone number is required",
    }),
    password: Joi.string().min(8).required().messages({
      "string.base": "Password must be a string",
      "string.empty": "Password is required",
      "string.min": "Password must be at least 8 characters",
      "any.required": "Password is required",
    }),
    profilePicture: Joi.string().uri().optional().messages({
      "string.base": "Profile picture must be a string",
      "string.uri": "Profile picture must be a valid URL",
    }),
  })
    .unknown(false)
    .messages({
      "object.unknown":
        'Field "{{#label}}" is not allowed for admin registration',
    }),
};

/* ── Login ── */

const loginSchema = {
  body: Joi.object({
    email: Joi.string().email().required().messages({
      "string.base": "Email must be a string",
      "string.empty": "Email is required",
      "string.email": "Please enter a valid email address",
      "any.required": "Email is required",
    }),
    password: Joi.string().required().messages({
      "string.base": "Password must be a string",
      "string.empty": "Password is required",
      "any.required": "Password is required",
    }),
  })
    .unknown(false)
    .messages({
      "object.unknown": 'Field "{{#label}}" is not allowed for login',
    }),
};

/* ── Refresh Token ── */

const refreshTokenSchema = {
  body: Joi.object({
    token: Joi.string().required().messages({
      "string.base": "Refresh token must be a string",
      "string.empty": "Refresh token is required",
      "any.required": "Refresh token is required",
    }),
  })
    .unknown(false)
    .messages({
      "object.unknown": 'Field "{{#label}}" is not allowed',
    }),
};

/* ── Forgot Password ── */

const forgotPasswordSchema = {
  body: Joi.object({
    email: Joi.string().email().required().messages({
      "string.base": "Email must be a string",
      "string.empty": "Email is required",
      "string.email": "Please enter a valid email address",
      "any.required": "Email is required",
    }),
  })
    .unknown(false)
    .messages({
      "object.unknown": 'Field "{{#label}}" is not allowed',
    }),
};

/* ── Verify Email ── */

const verifyEmailSchema = {
  params: Joi.object({
    id: objectId.required().messages({
      "any.invalid": "User ID must be a valid ID",
      "any.required": "User ID is required",
    }),
    token: Joi.string().required().messages({
      "string.base": "Verification token must be a string",
      "string.empty": "Verification token is required",
      "any.required": "Verification token is required",
    }),
  }),
};

/* ── Reset Password ── */

const resetPasswordSchema = {
  params: Joi.object({
    id: objectId.required().messages({
      "any.invalid": "User ID must be a valid ID",
      "any.required": "User ID is required",
    }),
    token: Joi.string().required().messages({
      "string.base": "Reset token must be a string",
      "string.empty": "Reset token is required",
      "any.required": "Reset token is required",
    }),
  }),
  body: Joi.object({
    password: Joi.string().min(8).required().messages({
      "string.base": "Password must be a string",
      "string.empty": "Password is required",
      "string.min": "Password must be at least 8 characters",
      "any.required": "Password is required",
    }),
    confirmPassword: Joi.string()
      .valid(Joi.ref("password"))
      .required()
      .messages({
        "string.base": "Confirm password must be a string",
        "string.empty": "Please confirm your password",
        "any.only": "Passwords do not match",
        "any.required": "Please confirm your password",
      }),
  })
    .unknown(false)
    .messages({
      "object.unknown": 'Field "{{#label}}" is not allowed',
    }),
};

/* ── Update Password ── */

const updatePasswordSchema = {
  params: Joi.object({
    id: objectId.required().messages({
      "any.invalid": "User ID must be a valid ID",
      "any.required": "User ID is required",
    }),
  }),
  body: Joi.object({
    oldPassword: Joi.string().required().messages({
      "string.base": "Current password must be a string",
      "string.empty": "Current password is required",
      "any.required": "Current password is required",
    }),
    newPassword: Joi.string().min(8).required().messages({
      "string.base": "New password must be a string",
      "string.empty": "New password is required",
      "string.min": "New password must be at least 8 characters",
      "any.required": "New password is required",
    }),
    confirmNewPassword: Joi.string()
      .valid(Joi.ref("newPassword"))
      .required()
      .messages({
        "string.base": "Confirm new password must be a string",
        "string.empty": "Please confirm your new password",
        "any.only": "Passwords do not match",
        "any.required": "Please confirm your new password",
      }),
  })
    .unknown(false)
    .messages({
      "object.unknown": 'Field "{{#label}}" is not allowed',
    }),
};

/* ── Get User By Id ── */

const getUserByIdSchema = {
  params: Joi.object({
    id: objectId.required().messages({
      "any.invalid": "User ID must be a valid ID",
      "any.required": "User ID is required",
    }),
  }),
};

/* ── Update User ── */

const updateUserSchema = {
  params: Joi.object({
    id: objectId.required().messages({
      "any.invalid": "User ID must be a valid ID",
      "any.required": "User ID is required",
    }),
  }),
  body: Joi.object({
    firstname: Joi.string().min(2).optional().messages({
      "string.base": "First name must be a string",
      "string.min": "First name must be at least 2 characters",
    }),
    lastname: Joi.string().min(2).optional().messages({
      "string.base": "Last name must be a string",
      "string.min": "Last name must be at least 2 characters",
    }),
    phoneNumber: Joi.string().optional().messages({
      "string.base": "Phone number must be a string",
    }),
    profilePicture: Joi.string().uri().optional().allow("").messages({
      "string.base": "Profile picture must be a string",
      "string.uri": "Profile picture must be a valid URL",
    }),
    dateOfBirth: Joi.string().optional().messages({
      "string.base": "Date of birth must be a string",
    }),
    gender: Joi.string()
      .valid("male", "female", "other", "prefer-not-to-say")
      .optional()
      .messages({
        "string.base": "Gender must be a string",
        "any.only":
          "Gender must be one of: male, female, other, prefer-not-to-say",
      }),
    address: addressSchema.optional(),
    timezone: Joi.string().optional().messages({
      "string.base": "Timezone must be a string",
    }),
    bio: Joi.string().optional().allow("").messages({
      "string.base": "Bio must be a string",
    }),
    languages: Joi.array().items(languageObject).messages({
      "array.base": "Languages must be an array",
    }),
    nativeLanguage: Joi.string().optional().messages({
      "string.base": "Native language must be a string",
    }),
    hourlyRate: Joi.number().min(0).optional().messages({
      "number.base": "Hourly rate must be a number",
      "number.min": "Hourly rate cannot be negative",
    }),
    yearsOfExperience: Joi.number().min(0).optional().messages({
      "number.base": "Years of experience must be a number",
      "number.min": "Years of experience cannot be negative",
    }),
    certifications: Joi.array().items(certificationSchema).optional().messages({
      "array.base": "Certifications must be an array",
    }),
    education: Joi.array().items(educationSchema).optional().messages({
      "array.base": "Education must be an array",
    }),
    specializations: Joi.array()
      .items(
        Joi.string().messages({
          "string.base": "Each specialization must be a string",
        })
      )
      .optional()
      .messages({
        "array.base": "Specializations must be an array",
      }),
    teachingPreferences: teachingPreferencesSchema.optional(),
    learningPreferences: learningPreferencesSchema.optional(),
    notificationPreferences: notificationPreferencesSchema.optional(),
    trialLessonOffered: Joi.boolean().optional().messages({
      "boolean.base": "Trial lesson offered must be true or false",
    }),
    trialLessonPrice: Joi.number().min(0).optional().messages({
      "number.base": "Trial lesson price must be a number",
      "number.min": "Trial lesson price cannot be negative",
    }),
    introVideoUrl: Joi.string().uri().optional().allow("").messages({
      "string.base": "Intro video URL must be a string",
      "string.uri": "Intro video URL must be a valid URL",
    }),
  })
    .unknown(false)
    .messages({
      "object.unknown":
        'Field "{{#label}}" is not allowed when updating a profile',
    }),
};

/* ── Get Tutors (public listing) ── */

const getTutorsSchema = {
  query: Joi.object({
    page: Joi.string().optional().messages({
      "string.base": "Page must be a string",
    }),
    limit: Joi.string().optional().messages({
      "string.base": "Limit must be a string",
    }),
    search: Joi.string().optional().allow("").messages({
      "string.base": "Search must be a string",
    }),
    sort: Joi.string()
      .valid("rating", "price_low", "price_high", "experience", "newest")
      .optional()
      .messages({
        "string.base": "Sort must be a string",
        "any.only":
          "Sort must be one of: rating, price_low, price_high, experience, newest",
      }),
    language: Joi.string().optional().messages({
      "string.base": "Language filter must be a string",
    }),
    specialization: Joi.string().optional().messages({
      "string.base": "Specialization filter must be a string",
    }),
    minPrice: Joi.string().optional().messages({
      "string.base": "Min price must be a string",
    }),
    maxPrice: Joi.string().optional().messages({
      "string.base": "Max price must be a string",
    }),
    level: Joi.string()
      .valid(
        "beginner",
        "elementary",
        "intermediate",
        "upper-intermediate",
        "advanced"
      )
      .optional()
      .messages({
        "string.base": "Level must be a string",
        "any.only":
          "Level must be one of: beginner, elementary, intermediate, upper-intermediate, advanced",
      }),
  })
    .unknown(false)
    .messages({
      "object.unknown": 'Query parameter "{{#label}}" is not supported',
    }),
};

export const deleteAccountValidation = () =>
  validate({
    params: Joi.object({
      id: objectId.required().messages({
        "any.invalid": "User ID must be a valid ID",
        "any.required": "User ID is required",
      }),
    }),
  });
/* ══════════════════════════════════════════════
   Export validation middleware functions
   ══════════════════════════════════════════════ */

export const registerStudentValidation = () =>
  validate(registerStudentSchema, { context: true }, { abortEarly: false });

export const registerTutorValidation = () =>
  validate(registerTutorSchema, { context: true }, { abortEarly: false });

export const registerAdminValidation = () =>
  validate(registerAdminSchema, { context: true }, { abortEarly: false });

export const loginValidation = () =>
  validate(loginSchema, { context: true }, { abortEarly: false });

export const refreshTokenValidation = () =>
  validate(refreshTokenSchema, { context: true }, { abortEarly: false });

export const forgotPasswordValidation = () =>
  validate(forgotPasswordSchema, { context: true }, { abortEarly: false });

export const verifyEmailValidation = () =>
  validate(verifyEmailSchema, { context: true }, { abortEarly: false });

export const resetPasswordValidation = () =>
  validate(resetPasswordSchema, { context: true }, { abortEarly: false });

export const updatePasswordValidation = () =>
  validate(updatePasswordSchema, { context: true }, { abortEarly: false });

export const getUserByIdValidation = () =>
  validate(getUserByIdSchema, { context: true }, { abortEarly: false });

export const updateUserValidation = () =>
  validate(updateUserSchema, { context: true }, { abortEarly: false });

export const getTutorsValidation = () =>
  validate(getTutorsSchema, { context: true }, { abortEarly: false });
