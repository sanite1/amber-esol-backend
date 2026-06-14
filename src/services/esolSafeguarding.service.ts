import { Types } from "mongoose";
import ApiError from "../errors/apiError";
import ApiResponse from "../errors/apiResponse";
import SafeguardingAlert from "../models/SafeguardingAlert";

interface ListAlertsOptions {
  page?: string;
  limit?: string;
  status?: string;
  alertLevel?: string;
  orgId?: string;
}

interface CallerContext {
  callerId: string;
  callerRole: string;
  callerOrgId?: string | null;
}

/* ── List Alerts ── */

export const listAlertsService = async (
  options: ListAlertsOptions,
  caller: CallerContext,
) => {
  const page = parseInt(options.page || "1", 10);
  const limit = parseInt(options.limit || "20", 10);
  const skip = (page - 1) * limit;

  const query: any = {};

  // Org admins can only see their own org's alerts
  if (caller.callerRole === "org_admin") {
    if (!caller.callerOrgId) {
      throw new ApiError(400, "Organisation context required");
    }
    query.orgId = caller.callerOrgId;
  } else if (caller.callerRole === "admin" && options.orgId) {
    query.orgId = options.orgId;
  }

  if (options.status) query.status = options.status;
  if (options.alertLevel) query.alertLevel = options.alertLevel;

  const [alerts, total] = await Promise.all([
    SafeguardingAlert.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("learnerId", "firstname lastname email esolLevel")
      .populate("orgId", "name")
      .populate("reviewedBy", "firstname lastname email"),
    SafeguardingAlert.countDocuments(query),
  ]);

  return new ApiResponse(200, "Safeguarding alerts retrieved", {
    alerts,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
};

/* ── Get single alert ── */

export const getAlertService = async (
  alertId: string,
  caller: CallerContext,
) => {
  const alert = await SafeguardingAlert.findById(alertId)
    .populate("learnerId", "firstname lastname email esolLevel")
    .populate("orgId", "name")
    .populate(
      "sessionId",
      "topic sessionMode esolLevel turns assessmentSummary",
    )
    .populate("reviewedBy", "firstname lastname email");

  if (!alert) {
    throw new ApiError(404, "Safeguarding alert not found");
  }

  if (
    caller.callerRole === "org_admin" &&
    alert.orgId.toString() !== caller.callerOrgId
  ) {
    throw new ApiError(403, "Access denied to this alert");
  }

  return new ApiResponse(200, "Alert retrieved", alert.toJSON());
};

/* ── Review alert ── */

export const reviewAlertService = async (
  alertId: string,
  data: { status: string; resolution?: string },
  caller: CallerContext,
) => {
  const alert = await SafeguardingAlert.findById(alertId);
  if (!alert) {
    throw new ApiError(404, "Safeguarding alert not found");
  }

  // Only platform admin can update review status
  if (caller.callerRole !== "admin") {
    throw new ApiError(403, "Only platform admins can review alerts");
  }

  alert.status = data.status as typeof alert.status;
  if (data.resolution !== undefined) {
    alert.resolution = data.resolution;
  }
  alert.reviewedBy = new Types.ObjectId(caller.callerId);
  alert.reviewedAt = new Date();
  await alert.save();

  return new ApiResponse(200, "Alert reviewed successfully", alert.toJSON());
};
