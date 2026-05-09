import { createHash, randomBytes } from "crypto";
import ApiError from "../errors/apiError";
import ApiResponse from "../errors/apiResponse";
import SessionToken from "../models/SessionToken";
import AISession from "../models/AISession";

const TOKEN_VALIDITY_MINUTES = 60;

const hashToken = (raw: string): string =>
  createHash("sha256").update(raw).digest("hex");

/**
 * Generate a one-time access token for a learner to join a session.
 * The raw token is returned ONCE — only the SHA-256 hash is stored.
 */
export const generateSessionTokenService = async (params: {
  sessionId: string;
  callerId: string;
  callerRole: string;
  callerOrgId?: string | null;
}) => {
  const session = await AISession.findById(params.sessionId);
  if (!session) {
    throw new ApiError(404, "Session not found");
  }

  // Authorisation: teacher (own session), org_admin (own org), platform admin
  if (
    params.callerRole === "tutor" &&
    session.teacherId.toString() !== params.callerId
  ) {
    throw new ApiError(403, "You can only generate tokens for your own sessions");
  }
  if (
    params.callerRole === "org_admin" &&
    session.orgId.toString() !== params.callerOrgId
  ) {
    throw new ApiError(403, "Access denied to this session");
  }
  if (
    params.callerRole !== "tutor" &&
    params.callerRole !== "org_admin" &&
    params.callerRole !== "admin"
  ) {
    throw new ApiError(403, "Access denied");
  }

  const rawToken = randomBytes(32).toString("hex");
  const tokenHash = hashToken(rawToken);

  const expiresAt = new Date();
  expiresAt.setMinutes(expiresAt.getMinutes() + TOKEN_VALIDITY_MINUTES);

  await SessionToken.create({
    learnerId: session.learnerId,
    sessionId: session._id,
    bookingId: session.bookingId ?? null,
    orgId: session.orgId,
    token: tokenHash,
    expiresAt,
    isActive: true,
  });

  return new ApiResponse(201, "Session access token generated", {
    token: rawToken,
    expiresAt,
    sessionId: session._id,
  });
};

/**
 * Validate a learner's session access token and bind it to the session.
 * Returns the session ID the token unlocks. Single-use — marked consumed on success.
 */
export const validateSessionTokenService = async (params: {
  rawToken: string;
  learnerId: string;
}) => {
  const tokenHash = hashToken(params.rawToken);

  const sessionToken = await SessionToken.findOne({
    token: tokenHash,
    isActive: true,
  });

  if (!sessionToken) {
    throw new ApiError(400, "Invalid or already-used session token");
  }

  if (sessionToken.expiresAt < new Date()) {
    throw new ApiError(400, "This session token has expired");
  }

  if (sessionToken.learnerId.toString() !== params.learnerId) {
    throw new ApiError(403, "This token does not belong to you");
  }

  // Bind to the specific session this token was issued for
  const session = await AISession.findById(sessionToken.sessionId);
  if (!session) {
    throw new ApiError(404, "Session not found");
  }
  if (session.completedAt) {
    throw new ApiError(400, "This session has already been completed");
  }

  // Mark token as consumed
  sessionToken.usedAt = new Date();
  sessionToken.isActive = false;
  await sessionToken.save();

  return new ApiResponse(200, "Session token accepted", {
    sessionId: session._id,
    sessionMode: session.sessionMode,
    esolLevel: session.esolLevel,
    topic: session.topic,
  });
};
