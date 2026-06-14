/**
 * Teacher teaching-profile self-service — the data side of the
 * matching foundation (see teacherMatching.service.ts).
 *
 *   GET   /api/teacher/teaching-profile     hydrate the editor
 *   PATCH /api/teacher/teaching-profile     replace the profile
 *
 * PATCH replaces the whole profile object (the editor always submits
 * all three arrays), with values whitelisted server-side: levels
 * against TEACHING_LEVEL_CODES, specialisms against
 * TEACHER_SPECIALISMS. Languages are free-form display names (they
 * must line up with learner l1Language values, which are themselves
 * free-form from onboarding) — trimmed + deduped only.
 */

import { Types } from "mongoose";
import ApiError from "../errors/apiError";
import ApiResponse from "../errors/apiResponse";
import User from "../models/User";
import {
  TEACHER_SPECIALISMS,
  TEACHING_LEVEL_CODES,
  levelToCode,
} from "./teacherMatching.service";

export interface TeachingProfileBody {
  levels_taught?: string[];
  languages_spoken?: string[];
  specialisms?: string[];
}

const cleanStrings = (arr: unknown): string[] =>
  Array.isArray(arr)
    ? Array.from(
        new Set(
          arr
            .map((v) => (typeof v === "string" ? v.trim() : ""))
            .filter((v) => v.length > 0),
        ),
      )
    : [];

export const getTeachingProfileService = async (
  teacherId: string,
): Promise<ApiResponse> => {
  if (!teacherId || !Types.ObjectId.isValid(teacherId)) {
    throw new ApiError(400, "Authenticated teacher id required");
  }
  const user = await User.findById(teacherId)
    .select("role teaching_profile")
    .lean();
  if (!user) throw new ApiError(404, "Teacher not found");
  if (user.role !== "tutor") {
    throw new ApiError(403, "Teaching profile is teacher-only");
  }

  return new ApiResponse(200, "Teaching profile", {
    teaching_profile: {
      levels_taught: user.teaching_profile?.levels_taught ?? [],
      languages_spoken: user.teaching_profile?.languages_spoken ?? [],
      specialisms: user.teaching_profile?.specialisms ?? [],
    },
    // Canonical option lists so the FE editor and the validator can
    // never drift apart.
    available_levels: TEACHING_LEVEL_CODES,
    available_specialisms: TEACHER_SPECIALISMS,
  });
};

export const updateTeachingProfileService = async (
  teacherId: string,
  body: TeachingProfileBody,
): Promise<ApiResponse> => {
  if (!teacherId || !Types.ObjectId.isValid(teacherId)) {
    throw new ApiError(400, "Authenticated teacher id required");
  }
  const user = await User.findById(teacherId).select("role").lean();
  if (!user) throw new ApiError(404, "Teacher not found");
  if (user.role !== "tutor") {
    throw new ApiError(403, "Teaching profile is teacher-only");
  }

  // Whitelist levels (accepts display form, stores codes).
  const levels = cleanStrings(body.levels_taught)
    .map(levelToCode)
    .filter((c): c is string => c !== null);

  const specialisms = cleanStrings(body.specialisms).filter((s) =>
    (TEACHER_SPECIALISMS as readonly string[]).includes(s),
  );

  const languages = cleanStrings(body.languages_spoken);

  const teaching_profile = {
    levels_taught: Array.from(new Set(levels)),
    languages_spoken: languages,
    specialisms,
  };

  await User.updateOne({ _id: teacherId }, { $set: { teaching_profile } });

  return new ApiResponse(200, "Teaching profile updated", {
    teaching_profile,
  });
};
