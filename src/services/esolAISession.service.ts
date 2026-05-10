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
import {
  processTurn as geminiProcessTurn,
  generateTeacherPrepNote,
  generateSessionSummary,
  DialogueHistoryEntry,
  ScenarioContext,
} from "./geminiAI.service";
import { loadScenario } from "./scenarioLoader.service";
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

  // ── Build context for Gemini single-call ──

  // Spaced repetition: 5 oldest/least-encountered vocab items for this learner
  const vocabToReinforce = await VocabLedger.aggregate([
    { $match: { learnerId: learner._id } },
    {
      $group: {
        _id: "$word",
        timesEncountered: { $sum: 1 },
        lastSeen: { $max: "$revisedAt" },
      },
    },
    { $sort: { timesEncountered: 1, lastSeen: 1 } },
    { $limit: 5 },
  ]);

  // Recent session summaries (for learner profile context)
  const recentSessions = await AISession.find({
    learnerId: learner._id,
    completedAt: { $ne: null },
    _id: { $ne: session._id },
  })
    .sort({ completedAt: -1 })
    .limit(3)
    .select("assessmentSummary");

  // Load scenario JSON if scenarioId is set on session.topic
  const scenario: ScenarioContext | undefined = session.topic
    ? loadScenario(session.topic, learner.l1Language || "en")
    : undefined;

  const history: DialogueHistoryEntry[] = session.turns.flatMap((t) => [
    { role: "user", content: t.originalInput },
    { role: "assistant", content: t.deepSeekResponse },
  ]);

  // ── Single Gemini call (replaces the old 5-stage pipeline) ──
  let result;
  try {
    result = await geminiProcessTurn({
      learnerInput: params.input,
      scenario,
      learner: {
        esolLevel: session.esolLevel,
        l1Language: learner.l1Language ?? "",
        vocabularyToReinforce: vocabToReinforce.map((v) => v._id),
        recentSessionSummaries: recentSessions
          .map((s) => s.assessmentSummary)
          .filter((x): x is string => Boolean(x)),
        skillWeaknessFlags: learner.skillWeaknessFlags ?? [],
        currentMode: session.sessionMode,
      },
      history,
    });
  } catch (err) {
    // Fail-closed: any AI failure on a learner turn is treated as a
    // safeguarding-relevant outage. Log and reject; pre-cached safeguarding
    // signposting can be served by the frontend on 503.
    logger.error({ err }, "Gemini turn failed — rejecting turn");
    throw err; // ApiError already wrapped in geminiProcessTurn
  }

  // ── Safeguarding handling ──
  if (result.safeguarding_flag) {
    const alert = await SafeguardingAlert.create({
      learnerId: session.learnerId,
      orgId: session.orgId,
      sessionId: session._id,
      alertLevel: result.safeguarding_category === "self_harm" ? "critical" : "high",
      triggerTextHash: sha256(params.input),
      claudeReasoning: `Category: ${result.safeguarding_category ?? "unknown"}`,
      status: "open",
    });

    session.safeguardingFlagged = true;
    session.safeguardingAlertId = alert._id as Types.ObjectId;

    const org = await Organisation.findById(session.orgId).select("name");
    sendSafeguardingAlertMail({
      alertLevel: alert.alertLevel,
      learnerName: `${learner.firstname} ${learner.lastname}`,
      orgName: org?.name ?? "Unknown organisation",
      sessionId: session._id.toString(),
      reasoning: `Category: ${result.safeguarding_category ?? "unknown"}`,
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
  }

  // ── Persist turn + vocab ──
  const turn: IAISessionTurn = {
    turnIndex: session.turns.length,
    originalInput: params.input,
    scrubbed: false, // No scrubbing — Vertex EU keeps data in EU
    deepSeekResponse: result.reply, // field name retained for backward compatibility
    claudeAssessment: result.grammar_feedback ?? "",
    safeguardingScore: result.safeguarding_flag ? 0.9 : 0,
    timestamp: new Date(),
  };

  session.turns.push(turn);
  session.sessionMode = result.mode;
  if (result.vocabulary_items_used.length > 0) {
    const existing = new Set(session.vocabIntroduced ?? []);
    for (const word of result.vocabulary_items_used) existing.add(word);
    session.vocabIntroduced = Array.from(existing);
  }
  if (result.session_complete) {
    session.completedAt = new Date();
    session.assessmentSummary = result.session_summary ?? undefined;
  }

  await session.save();

  // Bulk insert vocab to ledger (best-effort)
  if (result.vocabulary_items_used.length > 0) {
    const vocabDocs = result.vocabulary_items_used.map((word) => ({
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
    response: result.reply,
    mode: result.mode,
    assessment: result.grammar_feedback ?? "",
    grammarFeedback: result.grammar_feedback ?? "",
    comprehensionScore: result.turn_score,
    vocabIntroduced: result.vocabulary_items_used,
    skillCodesUsed: result.skill_codes_used,
    safeguardingFlagged: result.safeguarding_flag,
    safeguardingCategory: result.safeguarding_category,
    sessionComplete: result.session_complete,
    sessionSummary: result.session_summary,
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
          `Turn ${t.turnIndex + 1}\nLearner: ${t.originalInput}\nTutor: ${t.deepSeekResponse}\nAssessment: ${t.claudeAssessment ?? "n/a"}`
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
    l1Language: learner?.l1Language ?? "",
    topic: session.topic ?? undefined,
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
