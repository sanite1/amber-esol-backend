import ApiError from "../errors/apiError";
import ApiResponse from "../errors/apiResponse";
import User from "../models/User";

/* ── List Learners (scoped to org) ── */

export const listLearnersService = async (
  callerOrgId: string | null | undefined,
  callerRole: string,
  options: {
    orgId?: string;
    page?: string;
    limit?: string;
    search?: string;
    esolLevel?: string;
    fundingStatus?: string;
  }
) => {
  const page = parseInt(options.page || "1", 10);
  const limit = parseInt(options.limit || "20", 10);
  const skip = (page - 1) * limit;

  const resolvedOrgId =
    callerRole === "org_admin" ? callerOrgId : options.orgId;

  if (!resolvedOrgId) {
    throw new ApiError(400, "Organisation ID is required");
  }

  const query: any = {
    role: "student",
    orgId: resolvedOrgId,
  };

  if (options.search) {
    const escaped = options.search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(escaped, "i");
    query.$or = [{ firstname: regex }, { lastname: regex }, { email: regex }];
  }
  if (options.esolLevel) {
    query.esolLevel = options.esolLevel;
  }
  if (options.fundingStatus) {
    query.fundingStatus = options.fundingStatus;
  }

  const [learners, total] = await Promise.all([
    User.find(query)
      .select(
        "firstname lastname email phoneNumber esolLevel l1Language uln ulnStatus fundingStatus esolOnboardedAt verified isActive status createdAt"
      )
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
    User.countDocuments(query),
  ]);

  return new ApiResponse(200, "Learners retrieved successfully", {
    learners,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
};

/* ── Get Learner ESOL Profile ── */

export const getLearnerService = async (
  orgId: string,
  learnerId: string,
  callerRole: string,
  callerOrgId?: string | null
) => {
  const learner = await User.findOne({
    _id: learnerId,
    role: "student",
    orgId,
  }).select(
    "-password -verificationToken -resetToken -resetTokenExpires -googleAccessToken -googleRefreshToken -tokenExpiryDate"
  );

  if (!learner) {
    throw new ApiError(404, "Learner not found in this organisation");
  }

  if (callerRole === "org_admin" && callerOrgId !== orgId) {
    throw new ApiError(403, "Access denied to this organisation's learners");
  }

  return new ApiResponse(200, "Learner retrieved successfully", learner.toJSON());
};

/* ── Update Learner ESOL Data ── */

export const updateLearnerService = async (
  orgId: string,
  learnerId: string,
  data: {
    esolLevel?: string;
    l1Language?: string;
    uln?: string;
    ulnStatus?: string;
    fundingStatus?: string;
  }
) => {
  const learner = await User.findOneAndUpdate(
    { _id: learnerId, role: "student", orgId },
    data,
    { new: true, runValidators: true }
  ).select(
    "-password -verificationToken -resetToken -resetTokenExpires -googleAccessToken -googleRefreshToken -tokenExpiryDate"
  );

  if (!learner) {
    throw new ApiError(404, "Learner not found in this organisation");
  }

  return new ApiResponse(200, "Learner updated successfully", learner.toJSON());
};
