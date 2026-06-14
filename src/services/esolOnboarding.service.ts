import * as bcrypt from "bcrypt";
import { randomBytes } from "crypto";
import jwt from "jsonwebtoken";
import ApiError from "../errors/apiError";
import ApiResponse from "../errors/apiResponse";
import User from "../models/User";
import ReferralToken from "../models/ReferralToken";
import Organisation from "../models/Organisation";
import { sendVerificationMail } from "./nodemailer/mail.service";
import { validatePassword } from "../utils/validatePassword";
import { ocrResidencyDocument } from "./ocr.service";
import { computeFundingStatus } from "./eligibilityEngine.service";
import { autoAssignTeacherForLearner } from "./teacherMatching.service";
import {
  scorePlacementAssessment,
  AssessmentResponse,
} from "./geminiAI.service";
import {
  getQuestionsForAssessment,
  PLACEMENT_QUESTIONS,
} from "./placementAssessment.service";
import logger from "../config/logger";

const SALT_ROUNDS = 13;

interface ReferralJwtPayload {
  orgId: string;
  esolLevel?: string;
  email?: string;
  jti: string;
}

const verifyReferralToken = (token: string): ReferralJwtPayload => {
  const secret = process.env.REFERRAL_JWT_SECRET;
  if (!secret) throw new ApiError(500, "Referral JWT secret not configured");
  try {
    return jwt.verify(token, secret) as ReferralJwtPayload;
  } catch {
    throw new ApiError(400, "Invalid or expired invitation link");
  }
};

/* ── Step 1: validate referral token + return org/level preview ── */
// (Already implemented in esolReferralToken.service — kept for completeness.)

/* ── Step 2: get placement questions ── */

export const getPlacementQuestionsService = () => {
  const questions = getQuestionsForAssessment().map((q) => ({
    id: q.id,
    level: q.level,
    type: q.type,
    prompt: q.prompt,
    options: q.options,
    skillCode: q.skillCode,
    // correctAnswer intentionally NOT exposed to the client
  }));
  return new ApiResponse(200, "Placement questions retrieved", { questions });
};

/* ── Step 3: full onboarding (one big POST after the wizard) ── */

interface CompleteOnboardingRequest {
  // Referral
  token: string;

  // Personal
  firstname: string;
  lastname: string;
  email: string;
  phoneNumber: string;
  password: string;
  dateOfBirth?: string;
  nationality?: string;
  ethnicity?: string;
  l1Language: string;
  lldd_health_prob?: 1 | 2 | 9;
  employment_status?: "unemployed" | "employed" | "in_training";

  // Document (uploaded separately via multer, file URL passed here)
  residency_doc_ref?: string;

  // Placement assessment answers
  assessmentResponses: { questionId: string; answer: string }[];

  // ULN
  uln?: string;
}

export const completeOnboardingService = async (
  data: CompleteOnboardingRequest,
  uploadedFileBuffer?: Buffer,
) => {
  // 1. Verify referral token
  const decoded = verifyReferralToken(data.token);
  const referralRecord = await ReferralToken.findOne({
    token: data.token,
    isActive: true,
  });
  if (!referralRecord || referralRecord.usedBy) {
    throw new ApiError(400, "This invitation has already been used");
  }
  if (referralRecord.expiresAt < new Date()) {
    throw new ApiError(400, "This invitation link has expired");
  }
  if (decoded.email && decoded.email !== data.email.toLowerCase()) {
    throw new ApiError(
      400,
      "This invitation was issued for a different email address",
    );
  }

  const org = await Organisation.findById(decoded.orgId);
  if (!org || !org.isActive) {
    throw new ApiError(
      400,
      "The organisation associated with this invitation is no longer active",
    );
  }

  // 2. Check email uniqueness
  const existing = await User.findOne({ email: data.email.toLowerCase() });
  if (existing) {
    throw new ApiError(400, `A user with email ${data.email} already exists`);
  }
  validatePassword(data.password);

  // 3. OCR (if file provided)
  let ocrResult = null;
  let fundingStatus: "fundable" | "self_pay" | "manual_review" =
    "manual_review";
  if (uploadedFileBuffer) {
    try {
      ocrResult = await ocrResidencyDocument(uploadedFileBuffer);
      fundingStatus = computeFundingStatus({
        residencyDate: ocrResult.extractedDate,
        ocrConfidence: ocrResult.confidence,
      });
    } catch (err) {
      logger.warn(
        { err },
        "OCR failed during onboarding — flagging for manual review",
      );
      fundingStatus = "manual_review";
    }
  }

  // 4. Score placement assessment via Gemini
  const assessmentDocs: AssessmentResponse[] = data.assessmentResponses.map(
    (r) => {
      const q = PLACEMENT_QUESTIONS.find((p) => p.id === r.questionId);
      return {
        questionId: r.questionId,
        questionText: q?.prompt ?? "(unknown)",
        level: q?.level ?? "Entry 1",
        learnerAnswer: r.answer,
        correctAnswer: q?.correctAnswer,
      };
    },
  );

  let placement;
  try {
    placement = await scorePlacementAssessment(assessmentDocs);
  } catch (err) {
    logger.error({ err }, "Placement scoring failed — defaulting to Entry 1");
    placement = {
      nqfLevel: "Entry 1" as const,
      confidence: 0.5,
      skillWeaknessFlags: [],
      rationale:
        "Automated scoring was unavailable; learner placed at Entry 1 pending teacher review.",
    };
  }

  // 5. Create the learner record
  const hashedPassword = await bcrypt.hash(data.password, SALT_ROUNDS);
  const verificationToken = randomBytes(32).toString("hex");

  const learner = await User.create({
    firstname: data.firstname,
    lastname: data.lastname,
    email: data.email.toLowerCase(),
    phoneNumber: data.phoneNumber,
    password: hashedPassword,
    verificationToken,
    role: "student",
    status: "unverified",
    verified: false,
    isActive: true,
    dateOfBirth: data.dateOfBirth ? new Date(data.dateOfBirth) : undefined,
    nationality: data.nationality,
    ethnicity: data.ethnicity,
    lldd_health_prob: data.lldd_health_prob ?? 9,
    employment_status: data.employment_status,
    l1Language: data.l1Language,
    orgId: decoded.orgId,
    esolLevel: placement.nqfLevel,
    starting_level: placement.nqfLevel,
    current_level: placement.nqfLevel,
    assessment_score: placement.confidence,
    placement_confidence: placement.confidence,
    placement_rationale: placement.rationale,
    skillWeaknessFlags: placement.skillWeaknessFlags,
    fundingStatus,
    residency_doc_ref: data.residency_doc_ref,
    residency_date: ocrResult?.extractedDate ?? null,
    ocr_confidence: ocrResult?.confidence ?? null,
    uln: data.uln,
    ulnStatus: data.uln ? "pending" : "not_required",
    esolOnboardedAt: new Date(),
    totalLessonsTaken: 0,
    totalHoursLearned: 0,
    currentStreak: 0,
    longestStreak: 0,
  });

  // 6. Mark referral token consumed
  referralRecord.usedBy = learner._id as any;
  referralRecord.usedAt = new Date();
  referralRecord.isActive = false;
  await referralRecord.save();

  // 6b. Auto-assign a best-match teacher (teacherMatching.service.ts).
  // Fire-and-forget — a matching failure must never block
  // registration. Soft outcomes (no teachers, all at capacity) leave
  // the learner unassigned, exactly as before this hook existed; the
  // org admin's cohort table shows the unassigned count either way.
  autoAssignTeacherForLearner(learner._id as any).catch((err) =>
    logger.error(
      { err: (err as Error).message, learnerId: String(learner._id) },
      "Auto-assign on registration failed — learner left unassigned",
    ),
  );

  // 7. Send verification email — include the placement level so the
  // learner knows their result before they've even logged in.
  await sendVerificationMail(learner, {
    placementLevel: placement.nqfLevel,
    placementRationale: placement.rationale,
  }).catch(() => {});

  return new ApiResponse(
    201,
    "Onboarding complete. Please verify your email to continue.",
    {
      user: learner.toJSON(),
      placement: {
        nqfLevel: placement.nqfLevel,
        confidence: placement.confidence,
        rationale: placement.rationale,
      },
      fundingStatus,
    },
  );
};
