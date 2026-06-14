/**
 * Teacher learner list — Final Addendum §9, Todo 22.3.
 *
 *   GET /api/teacher/learners
 *
 * Returns the cohort of learners assigned to the calling teacher,
 * with the per-learner prep metadata that powers the teacher's
 * daily dashboard.
 *
 * Authorisation
 * =============
 *
 * The route layer mounts `isAuthenticated + requireTeacherRole +
 * requireTeacherContext`. This service receives `teacher_id` as an
 * explicit parameter sourced from `req.teacher_context` — it never
 * reads `req.user` directly (same invariant as
 * `requireOrgContext` enforces for `org_id`).
 *
 * The `assigned_teacher_id` filter is the security gate: a teacher
 * can only ever see learners whose User document points at their
 * own id. There's no cross-teacher leakage path even with a
 * crafted `?org_id` query param — `org_id` narrows the assigned
 * set, it doesn't widen it.
 *
 * Sort
 * ====
 *
 * Per the brief: `teacher_priority_level` ascending (p1 first,
 * p4 last), then `teacher_priority_updated_at` desc within tier.
 * Mongo sort on the enum string works because "p1" < "p2" < "p3"
 * < "p4" lexicographically — same order as the priority semantics.
 * Backed by the `{assigned_teacher_id: 1, teacher_priority_level: 1}`
 * compound index on the User model.
 */

import { Types } from "mongoose";
import ApiError from "../errors/apiError";
import ApiResponse from "../errors/apiResponse";
import User from "../models/User";
import Organisation from "../models/Organisation";

// ─────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────

const DEFAULT_PAGE_SIZE = 50;
const MIN_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 200;

const VALID_PRIORITIES = ["p1", "p2", "p3", "p4"] as const;
type Priority = (typeof VALID_PRIORITIES)[number];

// ─────────────────────────────────────────────────────────────────────
// Public shapes
// ─────────────────────────────────────────────────────────────────────

export interface ListTeacherLearnersQuery {
  priority?: string;
  org_id?: string;
  search?: string;
  page?: string;
  limit?: string;
}

export interface TeacherLearnerRow {
  _id: string;
  firstname: string;
  lastname: string;
  org_id: string;
  org_name: string;
  esol_level: string | null;
  teacher_priority_level: Priority;
  teacher_recommended_action: string | null;
  /**
   * Todo 23.5 — stable trigger key for client-side click dispatch.
   * Null on rows that pre-date the priority recalc worker.
   */
  teacher_priority_trigger_key: string | null;
  teacher_priority_updated_at: string | null;
  last_session_at: string | null;
  teacher_last_reviewed_at: string | null;
}

export interface ListTeacherLearnersResponse {
  teacher_id: string;
  learners: TeacherLearnerRow[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    total_pages: number;
  };
  /** Echo of the filters applied — useful for the UI's "showing X" line. */
  filters: {
    priority: Priority | null;
    org_id: string | null;
    search: string | null;
  };
}

// ─────────────────────────────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────────────────────────────

export const listTeacherLearnersService = async (
  teacher_id: string,
  query: ListTeacherLearnersQuery,
): Promise<ApiResponse> => {
  // ── Input validation ───────────────────────────────────────────
  if (!teacher_id || !Types.ObjectId.isValid(teacher_id)) {
    throw new ApiError(400, "Authenticated teacher id required");
  }

  // Priority — explicit whitelist so a misuse returns a precise
  // 400 rather than silently returning zero rows.
  let priorityFilter: Priority | null = null;
  if (query.priority !== undefined && query.priority !== "") {
    if (!(VALID_PRIORITIES as readonly string[]).includes(query.priority)) {
      throw new ApiError(
        400,
        `priority must be one of ${VALID_PRIORITIES.join(", ")}`,
      );
    }
    priorityFilter = query.priority as Priority;
  }

  // Org filter — when set, narrows the assigned-learner set. A
  // teacher can serve multiple orgs (per the brief); this lets them
  // focus the dashboard on one. We validate the ObjectId shape but
  // we DO NOT check whether the teacher actually has any learners
  // in this org — an empty result for a wrong org_id is the
  // honest answer; throwing 403 would leak whether the org exists.
  let orgFilter: Types.ObjectId | null = null;
  if (query.org_id !== undefined && query.org_id !== "") {
    if (!Types.ObjectId.isValid(query.org_id)) {
      throw new ApiError(400, "org_id must be a valid ObjectId");
    }
    orgFilter = new Types.ObjectId(query.org_id);
  }

  // Pagination — same defaults as the org-admin cohort table for
  // consistency.
  const rawPage = Number.parseInt(query.page ?? "1", 10);
  const rawLimit = Number.parseInt(
    query.limit ?? String(DEFAULT_PAGE_SIZE),
    10,
  );
  if (
    query.limit !== undefined &&
    (rawLimit < MIN_PAGE_SIZE || rawLimit > MAX_PAGE_SIZE)
  ) {
    throw new ApiError(
      400,
      `limit must be an integer between ${MIN_PAGE_SIZE} and ${MAX_PAGE_SIZE}`,
    );
  }
  const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;
  const limit = Math.min(
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_PAGE_SIZE,
    MAX_PAGE_SIZE,
  );
  const skip = (page - 1) * limit;

  // ── Build the Mongo filter ─────────────────────────────────────
  // The `assigned_teacher_id` filter is the security gate — it MUST
  // be the first key on the filter object so any future contributor
  // looking at this code sees the scoping immediately.
  const filter: Record<string, unknown> = {
    assigned_teacher_id: new Types.ObjectId(teacher_id),
    role: "student",
  };

  if (orgFilter) {
    filter.orgId = orgFilter;
  }
  if (priorityFilter) {
    filter.teacher_priority_level = priorityFilter;
  }

  // Search — case-insensitive prefix match on first + last name +
  // email + ULN. We use a regex (not text index) because the
  // search term is typed live in the dashboard's filter box and
  // prefix-matching feels responsive without indexing overhead.
  // Pattern is escaped so a user typing "." doesn't match every
  // name on the cohort.
  if (query.search !== undefined && query.search.trim().length > 0) {
    const escaped = query.search.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`^${escaped}`, "i");
    filter.$or = [
      { firstname: re },
      { lastname: re },
      { email: re },
      { uln: re },
    ];
  }

  // ── Two reads in parallel: page of rows + total count for paging
  // The `.populate("orgId", "name")` resolves the org name in a
  // single round-trip rather than per-row.
  const [docs, total] = await Promise.all([
    User.find(filter)
      .sort({
        teacher_priority_level: 1, // p1 → p4
        teacher_priority_updated_at: -1, // newest priority refresh first within tier
      })
      .skip(skip)
      .limit(limit)
      .select(
        "_id firstname lastname orgId esolLevel " +
          "teacher_priority_level teacher_recommended_action " +
          "teacher_priority_trigger_key teacher_priority_updated_at " +
          "last_session_at teacher_last_reviewed_at",
      )
      .populate("orgId", "name")
      .lean(),
    User.countDocuments(filter),
  ]);

  // ── Project to the public row shape ──────────────────────────
  const rows: TeacherLearnerRow[] = docs.map((d) => {
    const populatedOrg = (
      d as unknown as {
        orgId?: { _id: Types.ObjectId; name?: string } | Types.ObjectId | null;
      }
    ).orgId;
    const orgIdStr =
      populatedOrg && typeof populatedOrg === "object" && "_id" in populatedOrg
        ? (populatedOrg._id as Types.ObjectId).toString()
        : populatedOrg
          ? (populatedOrg as Types.ObjectId).toString()
          : "";
    const orgName =
      populatedOrg && typeof populatedOrg === "object" && "name" in populatedOrg
        ? ((populatedOrg as { name?: string }).name ?? "(unnamed org)")
        : "(unnamed org)";

    return {
      _id: (d._id as Types.ObjectId).toString(),
      firstname: d.firstname ?? "",
      lastname: d.lastname ?? "",
      org_id: orgIdStr,
      org_name: orgName,
      esol_level: (d as { esolLevel?: string | null }).esolLevel ?? null,
      teacher_priority_level: ((d as { teacher_priority_level?: Priority })
        .teacher_priority_level ?? "p4") as Priority,
      teacher_recommended_action:
        (d as { teacher_recommended_action?: string | null })
          .teacher_recommended_action ?? null,
      teacher_priority_trigger_key:
        (d as { teacher_priority_trigger_key?: string | null })
          .teacher_priority_trigger_key ?? null,
      teacher_priority_updated_at:
        (
          d as { teacher_priority_updated_at?: Date | null }
        ).teacher_priority_updated_at?.toISOString() ?? null,
      last_session_at:
        (
          d as { last_session_at?: Date | null }
        ).last_session_at?.toISOString() ?? null,
      teacher_last_reviewed_at:
        (
          d as { teacher_last_reviewed_at?: Date | null }
        ).teacher_last_reviewed_at?.toISOString() ?? null,
    };
  });

  // Sanity-touch on Organisation collection name access — keeps
  // tree-shaking honest and surfaces an import error early if
  // models are reshuffled. (No runtime cost beyond a property read.)
  void Organisation.collection.name;

  const payload: ListTeacherLearnersResponse = {
    teacher_id,
    learners: rows,
    pagination: {
      page,
      limit,
      total,
      total_pages: Math.ceil(total / limit) || 1,
    },
    filters: {
      priority: priorityFilter,
      org_id: orgFilter ? orgFilter.toString() : null,
      search: query.search?.trim() || null,
    },
  };
  return new ApiResponse(200, "Teacher learner list", payload);
};
