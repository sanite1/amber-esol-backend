import { createHash } from "crypto";
import { Types } from "mongoose";
import ApiError from "../errors/apiError";
import ApiResponse from "../errors/apiResponse";
import AISession from "../models/AISession";
import SafeguardingAlert from "../models/SafeguardingAlert";
import VocabLedger from "../models/VocabLedger";
import TeacherPrepNote from "../models/TeacherPrepNote";
import User from "../models/User";
import Organisation from "../models/Organisation";
import {
  AISessionMode,
  IAISessionTurn,
} from "../interfaces/aiSession.interface";
import { scrubPII } from "./nerScrubber.service";
import {
  safeguardScreen,
  assessTurn,
  generateTeacherPrepNote,
  generateSessionSummary,
} from "./claudeAI.service";
import { generateDialogue, DialogueHistoryEntry } from "./deepSeekAI.service";
import { sendSafeguardingAlertMail } from "./nodemailer/mail.service";
import logger from "../config/logger";

const sha256 = (text: string): string =>
  createHash("sha256").update(text).digest("hex");

/* ── Create AI Session ── */

export const createAISessionService = async (params: {
  learnerId: string;
  teacherId: string;
  bookingId?: string;
  sessionMode?: AISessionMode;
  topic?: string;
  callerId: string;
  callerRole: string;
  callerOrgId?: string | null;
}) => {
  const learner = await User.findOne({ _id: params.learnerId, role: "student" });
  if (!learner) {
    throw new ApiError(404, "Learner not found");
  }
  if (!learner.orgId) {
    throw new ApiError(400, "This learner is not enrolled with an organisation");
  }
  if (!learner.esolLevel) {
    throw new ApiError(400, "Learner does not have an ESOL level assigned");
  }

  // Authorisation: teacher creating own session, or org_admin within same org, or platform admin
  if (
    params.callerRole === "tutor" &&
    params.callerId !== params.teacherId
  ) {
    throw new ApiError(403, "Teachers can only create sessions for themselves");
  }
  if (
    params.callerRole === "org_admin" &&
    learner.orgId.toString() !== params.callerOrgId
  ) {
    throw new ApiError(403, "Access denied to this learner");
  }

  const teacher = await User.findOne({ _id: params.teacherId, role: "tutor" });
  if (!teacher) {
    throw new ApiError(404, "Teacher not found");
  }
  if (!teacher.esolTeacherApproved) {
    throw new ApiError(403, "Teacher is not approved for ESOL");
  }

  const session = await AISession.create({
    learnerId: learner._id,
    teacherId: teacher._id,
    orgId: learner.orgId,
    bookingId: params.bookingId,
    sessionMode: params.sessionMode ?? "BRIDGE",
    esolLevel: learner.esolLevel,
    topic: params.topic,
    turns: [],
    safeguardingFlagged: false,
  });

  return new ApiResponse(201, "Session created successfully", session.toJSON());
};

/* ── List Sessions ── */

export const listAISessionsService = async (params: {
  callerId: string;
  callerRole: string;
  callerOrgId?: string | null;
  page?: string;
  limit?: string;
  learnerId?: string;
  teacherId?: string;
}) => {
  const page = parseInt(params.page || "1", 10);
  const limit = parseInt(params.limit || "20", 10);
  const skip = (page - 1) * limit;

  const query: any = {};

  // Role scoping is locked first; only platform admins / org_admins may
  // refine further via learnerId/teacherId query params. Students and
  // tutors are pinned to their own data.
  if (params.callerRole === "student") {
    query.learnerId = params.callerId;
  } else if (params.callerRole === "tutor") {
    query.teacherId = params.callerId;
  } else if (params.callerRole === "org_admin") {
    if (!params.callerOrgId) {
      throw new ApiError(400, "Organisation context required");
    }
    query.orgId = params.callerOrgId;
    if (params.learnerId) query.learnerId = params.learnerId;
    if (params.teacherId) query.teacherId = params.teacherId;
  } else if (params.callerRole === "admin") {
    if (params.learnerId) query.learnerId = params.learnerId;
    if (params.teacherId) query.teacherId = params.teacherId;
  }

  const [sessions, total] = await Promise.all([
    AISession.find(query)
      .select("-turns")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("learnerId", "firstname lastname email esolLevel")
      .populate("teacherId", "firstname lastname email"),
    AISession.countDocuments(query),
  ]);

  return new ApiResponse(200, "Sessions retrieved successfully", {
    sessions,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
};

/* ── Get Single Session ── */

export const getAISessionService = async (params: {
  sessionId: string;
  callerId: string;
  callerRole: string;
  callerOrgId?: string | null;
}) => {
  const session = await AISession.findById(params.sessionId)
    .populate("learnerId", "firstname lastname email esolLevel")
    .populate("teacherId", "firstname lastname email");

  if (!session) {
    throw new ApiError(404, "Session not found");
  }

  // Authorisation
  const role = params.callerRole;
  const ownsAsLearner =
    role === "student" && session.learnerId._id.toString() === params.callerId;
  const ownsAsTeacher =
    role === "tutor" && session.teacherId._id.toString() === params.callerId;
  const sameOrg =
    role === "org_admin" && session.orgId.toString() === params.callerOrgId;
  const isPlatformAdmin = role === "admin";

  if (!ownsAsLearner && !ownsAsTeacher && !sameOrg && !isPlatformAdmin) {
    throw new ApiError(403, "Access denied to this session");
  }

  return new ApiResponse(200, "Session retrieved successfully", session.toJSON());
};

/* ── 5-Stage Turn Pipeline ── */

export const processTurnService = async (params: {
  sessionId: string;
  learnerId: string;
  input: string;
}) => {
  const session = await AISession.findOne({
    _id: params.sessionId,
    learnerId: params.learnerId,
  });

  if (!session) {
    throw new ApiError(404, "Session not found");
  }
  if (session.completedAt) {
    throw new ApiError(400, "This session has been completed");
  }

  const learner = await User.findById(params.learnerId).select(
    "firstname lastname l1Language esolLevel orgId"
  );
  if (!learner) {
    throw new ApiError(404, "Learner not found");
  }

  // ── Stage 1: Claude safeguarding screen ── (fail-closed)
  let safeguardResult;
  try {
    safeguardResult = await safeguardScreen(params.input);
  } catch (err) {
    // Hard fail if the safeguarding screen is unavailable — never proceed
    // unscreened. Audit the failure with an open alert so it surfaces in
    // the dashboard for review.
    logger.error(
      { err, sessionId: session._id.toString() },
      "Safeguarding screen unavailable — turn rejected"
    );
    await SafeguardingAlert.create({
      learnerId: session.learnerId,
      orgId: session.orgId,
      sessionId: session._id,
      alertLevel: "critical",
      triggerTextHash: sha256(params.input),
      claudeReasoning:
        "Safeguarding screen could not be executed; turn was rejected to ensure no unscreened content was processed.",
      status: "open",
    });
    throw new ApiError(
      503,
      "Tutor is temporarily unavailable. Please try again shortly."
    );
  }

  if (safeguardResult.flagged) {
    const alert = await SafeguardingAlert.create({
      learnerId: session.learnerId,
      orgId: session.orgId,
      sessionId: session._id,
      alertLevel: safeguardResult.level,
      triggerTextHash: sha256(params.input),
      claudeReasoning: safeguardResult.reasoning,
      status: "open",
    });

    session.safeguardingFlagged = true;
    session.safeguardingAlertId = alert._id as Types.ObjectId;

    // Send email alert (non-blocking). notificationSentAt is set ONLY
    // after the dispatch succeeds — we don't want the audit log to
    // claim a notification was sent when SMTP failed silently.
    const org = await Organisation.findById(session.orgId).select("name");
    sendSafeguardingAlertMail({
      alertLevel: safeguardResult.level,
      learnerName: `${learner.firstname} ${learner.lastname}`,
      orgName: org?.name ?? "Unknown organisation",
      sessionId: session._id.toString(),
      reasoning: safeguardResult.reasoning,
      raisedAt: new Date(),
    })
      .then(async () => {
        alert.notificationSentAt = new Date();
        await alert.save();
      })
      .catch((emailErr) =>
        logger.error(
          { err: emailErr, alertId: alert._id.toString() },
          "Failed to dispatch safeguarding alert email"
        )
      );

    // Critical concerns halt the session immediately
    if (safeguardResult.score >= 0.9) {
      await session.save();
      throw new ApiError(
        403,
        "Session paused for safeguarding review. Support has been notified and will be in touch."
      );
    }
  }

  // ── Stage 2: NER scrub ──
  const scrubResult = scrubPII(params.input);
  const scrubbedInput = scrubResult.scrubbed;

  // ── Stage 3: DeepSeek dialogue ──
  const history: DialogueHistoryEntry[] = session.turns.flatMap((t) => [
    { role: "user", content: scrubPII(t.originalInput).scrubbed },
    { role: "assistant", content: t.deepSeekResponse },
  ]);

  const dialogueResponse = await generateDialogue({
    sessionMode: session.sessionMode,
    esolLevel: session.esolLevel,
    l1Language: learner.l1Language,
    topic: session.topic,
    history,
    scrubbedInput,
  });

  // ── Stage 4: Claude assessment ──
  const assessment = await assessTurn({
    esolLevel: session.esolLevel,
    learnerInput: scrubbedInput,
    aiResponse: dialogueResponse,
  });

  // ── Stage 5: Persist turn + vocab ──
  const turn: IAISessionTurn = {
    turnIndex: session.turns.length,
    originalInput: params.input,
    scrubbed: scrubResult.scrubbedCount > 0,
    deepSeekResponse: dialogueResponse,
    claudeAssessment: assessment.assessment,
    safeguardingScore: safeguardResult.score,
    timestamp: new Date(),
  };

  session.turns.push(turn);
  if (assessment.vocabWords.length > 0) {
    const existing = new Set(session.vocabIntroduced ?? []);
    for (const word of assessment.vocabWords) existing.add(word);
    session.vocabIntroduced = Array.from(existing);
  }

  await session.save();

  // Bulk insert vocab to ledger (best-effort)
  if (assessment.vocabWords.length > 0) {
    const vocabDocs = assessment.vocabWords.map((word) => ({
      learnerId: session.learnerId,
      orgId: session.orgId,
      sessionId: session._id,
      word: word.toLowerCase(),
      esolLevel: session.esolLevel,
      topic: session.topic,
      introducedAt: new Date(),
    }));
    await VocabLedger.insertMany(vocabDocs, { ordered: false }).catch((err) =>
      logger.error({ err }, "Vocab ledger insert failed")
    );
  }

  return new ApiResponse(200, "Turn processed successfully", {
    response: dialogueResponse,
    assessment: assessment.assessment,
    grammarFeedback: assessment.grammarFeedback,
    comprehensionScore: assessment.comprehensionScore,
    vocabIntroduced: assessment.vocabWords,
    safeguardingFlagged: safeguardResult.flagged,
    redactionsApplied: scrubResult.redactionsApplied,
  });
};

/* ── Complete Session ── */

export const completeAISessionService = async (params: {
  sessionId: string;
  callerId: string;
  callerRole: string;
  callerOrgId?: string | null;
}) => {
  const session = await AISession.findById(params.sessionId);
  if (!session) {
    throw new ApiError(404, "Session not found");
  }
  if (session.completedAt) {
    throw new ApiError(400, "Session is already completed");
  }

  // Authorisation
  if (
    params.callerRole === "tutor" &&
    session.teacherId.toString() !== params.callerId
  ) {
    throw new ApiError(403, "You can only complete your own sessions");
  }
  if (
    params.callerRole === "org_admin" &&
    session.orgId.toString() !== params.callerOrgId
  ) {
    throw new ApiError(403, "Access denied to this session");
  }

  // Generate final session summary if there are any turns
  if (session.turns.length > 0) {
    const transcript = session.turns
      .map(
        (t) =>
          `Turn ${t.turnIndex + 1}\nLearner: ${scrubPII(t.originalInput).scrubbed}\nTutor: ${t.deepSeekResponse}\nAssessment: ${t.claudeAssessment ?? "n/a"}`
      )
      .join("\n\n");

    const summary = await generateSessionSummary(transcript);
    session.assessmentSummary = summary;
  }

  session.completedAt = new Date();
  await session.save();

  return new ApiResponse(200, "Session completed successfully", session.toJSON());
};

/* ── Teacher Prep Note ── */

export const getTeacherPrepNoteService = async (params: {
  sessionId: string;
  callerId: string;
  callerRole: string;
  callerOrgId?: string | null;
}) => {
  const session = await AISession.findById(params.sessionId);
  if (!session) {
    throw new ApiError(404, "Session not found");
  }

  // Authorisation
  if (
    params.callerRole === "tutor" &&
    session.teacherId.toString() !== params.callerId
  ) {
    throw new ApiError(403, "Access denied to this prep note");
  }
  if (
    params.callerRole === "org_admin" &&
    session.orgId.toString() !== params.callerOrgId
  ) {
    throw new ApiError(403, "Access denied to this prep note");
  }

  // Return cached prep note if it exists
  const existing = await TeacherPrepNote.findOne({ sessionId: session._id });
  if (existing) {
    if (
      params.callerRole === "tutor" &&
      !existing.viewedAt &&
      existing.teacherId.toString() === params.callerId
    ) {
      existing.viewedAt = new Date();
      existing.viewedBy = new Types.ObjectId(params.callerId);
      await existing.save();
    }
    return new ApiResponse(200, "Prep note retrieved", existing.toJSON());
  }

  // Generate new prep note
  const learner = await User.findById(session.learnerId).select(
    "l1Language esolLevel"
  );

  const recentSessions = await AISession.find({
    learnerId: session.learnerId,
    completedAt: { $ne: null },
    _id: { $ne: session._id },
  })
    .sort({ completedAt: -1 })
    .limit(5)
    .select("assessmentSummary topic createdAt");

  const summaries = recentSessions
    .map((s) => s.assessmentSummary)
    .filter((s): s is string => Boolean(s));

  const content = await generateTeacherPrepNote({
    esolLevel: session.esolLevel,
    l1Language: learner?.l1Language,
    topic: session.topic,
    sessionMode: session.sessionMode,
    recentSessionSummaries: summaries,
  });

  const prepNote = await TeacherPrepNote.create({
    teacherId: session.teacherId,
    learnerId: session.learnerId,
    orgId: session.orgId,
    bookingId: session.bookingId ?? new Types.ObjectId(),
    sessionId: session._id,
    content,
    generatedAt: new Date(),
    viewedAt: params.callerRole === "tutor" ? new Date() : null,
    viewedBy:
      params.callerRole === "tutor"
        ? new Types.ObjectId(params.callerId)
        : null,
  });

  return new ApiResponse(201, "Prep note generated", prepNote.toJSON());
};
