/**
 * Teacher self-service preferences — Final Addendum §11.
 *
 *   PATCH /api/teacher/preferences/auto-re-engagement
 *
 * Today this is one field; the service is structured so additional
 * teacher-only toggles can drop in without a second endpoint
 * (just extend the input shape + the $set payload).
 *
 * Auth: the route layer mounts `requireTeacherRole +
 * requireTeacherContext`, so we trust `teacher_id` here.
 */

import { Types } from "mongoose";
import ApiError from "../errors/apiError";
import ApiResponse from "../errors/apiResponse";
import User from "../models/User";
import logger from "../config/logger";

export interface UpdateAutoReEngagementBody {
  auto_re_engagement_enabled: boolean;
}

export interface UpdateAutoReEngagementInput {
  teacher_id: string;
  body: UpdateAutoReEngagementBody;
}

export interface UpdateAutoReEngagementResult {
  auto_re_engagement_enabled: boolean;
  updated_at: string;
}

export const updateAutoReEngagementService = async (
  input: UpdateAutoReEngagementInput,
): Promise<ApiResponse> => {
  if (!input.teacher_id || !Types.ObjectId.isValid(input.teacher_id)) {
    throw new ApiError(400, "Authenticated teacher id required");
  }
  if (typeof input.body?.auto_re_engagement_enabled !== "boolean") {
    throw new ApiError(
      400,
      "auto_re_engagement_enabled is required (boolean)",
    );
  }
  const teacherObjectId = new Types.ObjectId(input.teacher_id);
  const nextValue = input.body.auto_re_engagement_enabled;

  // Read the previous value for the audit row's before_state.
  // Defaults to true (matching the schema default) when the field
  // is missing on a pre-Phase-24 user row.
  const before = await User.findById(teacherObjectId)
    .select("auto_re_engagement_enabled role orgId")
    .lean();
  if (!before || before.role !== "tutor") {
    throw new ApiError(404, "Teacher not found");
  }
  const previousValue =
    (before as { auto_re_engagement_enabled?: boolean })
      .auto_re_engagement_enabled ?? true;

  const updatedAt = new Date();
  await User.updateOne(
    { _id: teacherObjectId },
    {
      $set: {
        auto_re_engagement_enabled: nextValue,
        // Touches the timestamps to keep the User doc's
        // updatedAt in sync with the change — useful for the
        // "what changed about this user recently?" debug view.
      },
    },
  );

  // Log-only audit — a preference toggle is low-stakes and the
  // AuditLog action enum is for compliance-relevant events.
  // logger.info is enough for ops to answer "did Sarah turn off
  // auto re-engagement?" without inflating the audit collection.
  if (previousValue !== nextValue) {
    logger.info(
      {
        teacher_id: input.teacher_id,
        before: previousValue,
        after: nextValue,
      },
      "teacherPreferences: auto_re_engagement_enabled flipped",
    );
  }

  const result: UpdateAutoReEngagementResult = {
    auto_re_engagement_enabled: nextValue,
    updated_at: updatedAt.toISOString(),
  };
  return new ApiResponse(200, "Preference updated", result);
};
