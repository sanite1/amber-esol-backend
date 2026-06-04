import ApiError from "../errors/apiError";
import ApiResponse from "../errors/apiResponse";
import SessionFeedback from "../models/SessionFeedback";
import AISession from "../models/AISession";

interface CallerContext {
  callerId: string;
  callerRole: string;
  callerOrgId?: string | null;
}

const loadSessionForFeedback = async (sessionId: string) => {
  const session = await AISession.findById(sessionId);
  if (!session) {
    throw new ApiError(404, "Session not found");
  }
  return session;
};

/* ── Submit learner feedback ── */

export const submitLearnerFeedbackService = async (
  sessionId: string,
  data: {
    rating?: number;
    emojiRating?: "struggling" | "okay" | "confident";
    comment?: string;
    topicsWorkedOn?: string[];
  },
  caller: CallerContext
) => {
  const session = await loadSessionForFeedback(sessionId);

  if (session.learnerId.toString() !== caller.callerId) {
    throw new ApiError(403, "You can only rate your own sessions");
  }
  if (!session.completedAt) {
    throw new ApiError(400, "You can only rate a completed session");
  }

  const feedback = await SessionFeedback.findOneAndUpdate(
    { sessionId: session._id },
    {
      $setOnInsert: {
        sessionId: session._id,
        bookingId: session.bookingId ?? undefined,
        learnerId: session.learnerId,
        teacherId: session.teacherId,
        orgId: session.orgId,
      },
      $set: {
        ...(data.rating !== undefined ? { learnerRating: data.rating } : {}),
        ...(data.emojiRating ? { emojiRating: data.emojiRating } : {}),
        ...(data.comment !== undefined ? { learnerComment: data.comment } : {}),
        ...(data.topicsWorkedOn && data.topicsWorkedOn.length > 0
          ? { topicsWorkedOn: data.topicsWorkedOn }
          : {}),
      },
    },
    { upsert: true, new: true, runValidators: true }
  );

  return new ApiResponse(200, "Feedback submitted. Thank you!", feedback.toJSON());
};

/* ── Submit teacher feedback ── */

export const submitTeacherFeedbackService = async (
  sessionId: string,
  data: {
    rating?: number;
    comment?: string;
    progressNotes?: string;
    topicsWorkedOn?: string[];
  },
  caller: CallerContext
) => {
  const session = await loadSessionForFeedback(sessionId);

  // Pre-platform sessions have no teacher and can't be feedback targets.
  if (
    !session.teacherId ||
    session.teacherId.toString() !== caller.callerId
  ) {
    throw new ApiError(403, "Only the assigned teacher can submit feedback");
  }
  if (!session.completedAt) {
    throw new ApiError(
      400,
      "Feedback can only be submitted after the session is completed"
    );
  }

  const update: any = {};
  if (data.rating !== undefined) update.teacherRating = data.rating;
  if (data.comment !== undefined) update.teacherComment = data.comment;
  if (data.progressNotes !== undefined)
    update.progressNotes = data.progressNotes;
  if (data.topicsWorkedOn && data.topicsWorkedOn.length > 0)
    update.topicsWorkedOn = data.topicsWorkedOn;

  const feedback = await SessionFeedback.findOneAndUpdate(
    { sessionId: session._id },
    {
      $setOnInsert: {
        sessionId: session._id,
        bookingId: session.bookingId ?? undefined,
        learnerId: session.learnerId,
        teacherId: session.teacherId,
        orgId: session.orgId,
      },
      $set: update,
    },
    { upsert: true, new: true, runValidators: true }
  );

  return new ApiResponse(200, "Feedback submitted successfully", feedback.toJSON());
};

/* ── Get feedback for a session ── */

export const getSessionFeedbackService = async (
  sessionId: string,
  caller: CallerContext
) => {
  const session = await loadSessionForFeedback(sessionId);

  // Authorisation: session participants + admins.
  // teacherId is null on pre-platform imports, so non-teacher callers
  // simply don't trigger the isTeacher branch.
  const isLearner = session.learnerId.toString() === caller.callerId;
  const isTeacher =
    !!session.teacherId &&
    session.teacherId.toString() === caller.callerId;
  const isSameOrg =
    caller.callerRole === "org_admin" &&
    session.orgId.toString() === caller.callerOrgId;
  const isPlatformAdmin = caller.callerRole === "admin";

  if (!isLearner && !isTeacher && !isSameOrg && !isPlatformAdmin) {
    throw new ApiError(403, "Access denied to this feedback");
  }

  const feedback = await SessionFeedback.findOne({
    sessionId: session._id,
  });

  return new ApiResponse(
    200,
    feedback ? "Feedback retrieved" : "No feedback yet",
    feedback ? feedback.toJSON() : null
  );
};
