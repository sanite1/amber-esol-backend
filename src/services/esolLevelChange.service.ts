import { Types } from "mongoose";
import ApiError from "../errors/apiError";
import ApiResponse from "../errors/apiResponse";
import LevelChange from "../models/LevelChange";
import User from "../models/User";

interface CallerContext {
  callerId: string;
  callerRole: string;
  callerOrgId?: string | null;
}

/* ── Create level change (also updates User.esolLevel) ── */

export const createLevelChangeService = async (
  data: {
    learnerId: string;
    toLevel: string;
    reason: string;
    evidenceSummary?: string;
    sessionId?: string;
    effectiveDate?: string;
  },
  caller: CallerContext
) => {
  const learner = await User.findOne({ _id: data.learnerId, role: "student" });
  if (!learner) {
    throw new ApiError(404, "Learner not found");
  }
  if (!learner.orgId) {
    throw new ApiError(400, "Learner is not enrolled with an organisation");
  }

  if (
    caller.callerRole === "org_admin" &&
    learner.orgId.toString() !== caller.callerOrgId
  ) {
    throw new ApiError(403, "Access denied to this learner");
  }

  const fromLevel = learner.esolLevel ?? "";
  if (fromLevel === data.toLevel) {
    throw new ApiError(
      400,
      "Target level is the same as the learner's current level"
    );
  }

  const change = await LevelChange.create({
    learnerId: learner._id,
    orgId: learner.orgId,
    fromLevel,
    toLevel: data.toLevel,
    changedBy: new Types.ObjectId(caller.callerId),
    reason: data.reason,
    evidenceSummary: data.evidenceSummary,
    sessionId: data.sessionId
      ? new Types.ObjectId(data.sessionId)
      : null,
    effectiveDate: data.effectiveDate
      ? new Date(data.effectiveDate)
      : new Date(),
  });

  // Update the learner's current level
  learner.esolLevel = data.toLevel;
  await learner.save();

  return new ApiResponse(201, "Level change recorded", change.toJSON());
};

/* ── List level changes ── */

export const listLevelChangesService = async (
  options: {
    page?: string;
    limit?: string;
    learnerId?: string;
    orgId?: string;
  },
  caller: CallerContext
) => {
  const page = parseInt(options.page || "1", 10);
  const limit = parseInt(options.limit || "20", 10);
  const skip = (page - 1) * limit;

  const query: any = {};

  if (caller.callerRole === "org_admin") {
    if (!caller.callerOrgId) {
      throw new ApiError(400, "Organisation context required");
    }
    query.orgId = caller.callerOrgId;
  } else if (caller.callerRole === "admin" && options.orgId) {
    query.orgId = options.orgId;
  }

  if (options.learnerId) query.learnerId = options.learnerId;

  const [changes, total] = await Promise.all([
    LevelChange.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("learnerId", "firstname lastname email")
      .populate("changedBy", "firstname lastname email role"),
    LevelChange.countDocuments(query),
  ]);

  return new ApiResponse(200, "Level changes retrieved", {
    changes,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
};
