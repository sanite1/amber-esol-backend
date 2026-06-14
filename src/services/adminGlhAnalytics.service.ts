/**
 * Amber-admin GLH analytics — Final Addendum §12.
 *
 *   GET /api/admin/glh-analytics?from=YYYY-MM-DD&to=YYYY-MM-DD[&org_id=…]
 *
 * Cross-platform window-scoped aggregates that validate the
 * "AI + teacher oversight" funding-model assumption. The brief's
 * target for the funding shape:
 *
 *   teacher GLH / total GLH ∈ [0.10, 0.20]
 *
 * Below 10% the teacher signal is too thin to satisfy the
 * "qualified teacher oversight" rule the funder cares about.
 * Above 20% the AI-tutor advantage erodes and the unit economics
 * stop working.
 *
 * Formula alignment with §12 ILR
 * ==============================
 *
 * This service deliberately mirrors `computeIlrLearnerGlh`
 * (the §12 formula helper) in its source mapping:
 *
 *   ai_glh             = Σ AISession.duration_mins / 60
 *                        where session_source === "ai_tutor"
 *                        AND created_at ∈ [from, to]
 *
 *   pre_platform_glh   = Σ AISession.duration_mins / 60
 *                        where session_source === "pre_platform"
 *                        AND created_at ∈ [from, to]
 *
 *   teacher_contact_glh = Σ TeacherReview.duration_mins / 60
 *                        where created_at ∈ [from, to]
 *
 *   total_glh           = ai + pre_platform + teacher_contact
 *
 *   ratio_teacher_to_total = teacher_contact_glh / total_glh
 *
 * The CRITICAL deviation from the ILR formula: this endpoint is
 * PERIOD-SCOPED, so `teacher_contact_glh` is the sum of
 * `TeacherReview.duration_mins` inside the window — NOT
 * `User.glh_teacher_contact` (which is the lifetime cumulative).
 * Using the lifetime field would conflate historic and in-window
 * contributions; a teacher who logged 50h last year and 5h this
 * period would look the same as a teacher who logged 55h this
 * period. The period-scoped tally answers "did the teacher
 * oversight actually happen in THIS window?", which is the
 * question the funding-model check needs.
 *
 * `teacher_consolidation` sessions are EXCLUDED from `ai_glh`
 * (matching the ILR formula's three-term decomposition) — the
 * matching TeacherReview already lands in `teacher_contact_glh`,
 * counting both would double-count the same teacher hour.
 *
 * Trend buckets
 * =============
 *
 * Window > 28 days → weekly buckets (start on Mon UTC).
 * Window ≤ 28 days → daily buckets.
 *
 * Empty buckets emit zero rows so the recharts area chart has a
 * continuous x-axis; never gaps. The bucket boundary is computed
 * in UTC to match the rest of the platform's date-handling.
 */

import { Types, PipelineStage } from "mongoose";
import AISession from "../models/AISession";
import TeacherReview from "../models/TeacherReview";
import Organisation from "../models/Organisation";
import ApiError from "../errors/apiError";
import ApiResponse from "../errors/apiResponse";

// ─────────────────────────────────────────────────────────────────────
// Public shapes
// ─────────────────────────────────────────────────────────────────────

export interface GlhAnalyticsQuery {
  from?: string;
  to?: string;
  org_id?: string;
}

export interface GlhBreakdown {
  total_glh: number;
  ai_glh: number;
  pre_platform_glh: number;
  teacher_contact_glh: number;
  /** ratio_teacher_to_total as a 0..1 number (UI multiplies by 100). */
  ratio_teacher_to_total: number;
}

export interface GlhAnalyticsResponse {
  /** Echo of the resolved window — useful when the caller omitted from/to. */
  period: { from: string; to: string; days: number };
  totals: GlhBreakdown;
  per_org: Array<GlhBreakdown & { org_id: string; org_name: string }>;
  /** Daily or weekly depending on window size; bucket interval echoed below. */
  trend: Array<GlhBreakdown & { bucket_start: string }>;
  /** "daily" | "weekly" — drives the chart x-axis label format. */
  trend_interval: "daily" | "weekly";
}

// ─────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const WEEKLY_THRESHOLD_DAYS = 28;
const DEFAULT_WINDOW_DAYS = 30;

// ─────────────────────────────────────────────────────────────────────
// Window helpers
// ─────────────────────────────────────────────────────────────────────

/**
 * Parse a YYYY-MM-DD string into a UTC Date at start-of-day.
 * Returns null on malformed input — the caller substitutes a
 * default when null.
 */
const parseIsoDate = (raw: string | undefined): Date | null => {
  if (!raw || typeof raw !== "string") return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const d = new Date(`${raw}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** Format a Date as YYYY-MM-DD in UTC for response echo. */
const toIsoDay = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * Resolve the [from, to] window from query input. Defaults:
 *   - to   = today (UTC end-of-day)
 *   - from = to − 30 days
 *
 * Both bounds are inclusive. Throws ApiError on inverted ranges
 * (caller mistake; better to surface 400 than silently swap).
 */
const resolveWindow = (
  query: GlhAnalyticsQuery,
): { from: Date; to: Date; days: number } => {
  const nowUtc = new Date();
  const todayStart = new Date(
    Date.UTC(
      nowUtc.getUTCFullYear(),
      nowUtc.getUTCMonth(),
      nowUtc.getUTCDate(),
    ),
  );
  const to = parseIsoDate(query.to) ?? todayStart;
  // Include the full `to` day → set end to 23:59:59.999 UTC.
  const toEnd = new Date(to.getTime() + MS_PER_DAY - 1);
  const from =
    parseIsoDate(query.from) ??
    new Date(toEnd.getTime() - DEFAULT_WINDOW_DAYS * MS_PER_DAY);

  if (from > toEnd) {
    throw new ApiError(
      400,
      `from (${toIsoDay(from)}) must be on or before to (${toIsoDay(to)})`,
    );
  }
  const days = Math.max(
    1,
    Math.ceil((toEnd.getTime() - from.getTime()) / MS_PER_DAY),
  );
  return { from, to: toEnd, days };
};

/**
 * Choose the bucket interval based on window size. Brief: weekly
 * when range > 28 days; daily otherwise.
 */
const chooseInterval = (days: number): "daily" | "weekly" =>
  days > WEEKLY_THRESHOLD_DAYS ? "weekly" : "daily";

/**
 * Snap a date down to the start of its bucket (00:00 UTC for
 * daily; Monday 00:00 UTC for weekly).
 *
 * ISO week starts on Monday — JS getUTCDay() returns 0 for Sunday,
 * 1 for Monday. Offset of (day + 6) % 7 normalises to "days since
 * Monday".
 */
const bucketStart = (d: Date, interval: "daily" | "weekly"): Date => {
  const utcDay = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
  );
  if (interval === "daily") return utcDay;
  const dow = (utcDay.getUTCDay() + 6) % 7;
  return new Date(utcDay.getTime() - dow * MS_PER_DAY);
};

/**
 * Enumerate every bucket boundary in the window. Used to fill
 * empty buckets in the trend output (a daily area chart with a
 * gap where nothing happened is harder to read than a flat zero).
 */
const enumerateBuckets = (
  from: Date,
  to: Date,
  interval: "daily" | "weekly",
): Date[] => {
  const buckets: Date[] = [];
  const stepMs = interval === "daily" ? MS_PER_DAY : 7 * MS_PER_DAY;
  let cursor = bucketStart(from, interval);
  while (cursor.getTime() <= to.getTime()) {
    buckets.push(new Date(cursor));
    cursor = new Date(cursor.getTime() + stepMs);
  }
  return buckets;
};

// ─────────────────────────────────────────────────────────────────────
// GLH arithmetic — same shape used in the ILR formula helper
// ─────────────────────────────────────────────────────────────────────

const round1dp = (n: number): number => Math.round(n * 10) / 10;
const round3dp = (n: number): number => Math.round(n * 1000) / 1000;

/**
 * Roll a `{ ai_glh, pre_platform_glh, teacher_contact_glh }` triple
 * into a full `GlhBreakdown` (adds `total_glh` + `ratio_teacher_to_total`).
 * Rounding happens once per call so trend rows and per-org rows
 * carry the same precision as the totals.
 */
const buildBreakdown = (
  aiGlh: number,
  prePlatformGlh: number,
  teacherContactGlh: number,
): GlhBreakdown => {
  const total = aiGlh + prePlatformGlh + teacherContactGlh;
  return {
    ai_glh: round1dp(aiGlh),
    pre_platform_glh: round1dp(prePlatformGlh),
    teacher_contact_glh: round1dp(teacherContactGlh),
    total_glh: round1dp(total),
    // Ratio at three decimal places (the UI's "12.4%" needs the
    // extra precision to round cleanly at one decimal).
    ratio_teacher_to_total: total > 0 ? round3dp(teacherContactGlh / total) : 0,
  };
};

// ─────────────────────────────────────────────────────────────────────
// Top-level entry
// ─────────────────────────────────────────────────────────────────────

export const getGlhAnalyticsService = async (
  query: GlhAnalyticsQuery,
): Promise<ApiResponse> => {
  if (query.org_id && !Types.ObjectId.isValid(query.org_id)) {
    throw new ApiError(400, "org_id must be a valid ObjectId");
  }
  const { from, to, days } = resolveWindow(query);
  const interval = chooseInterval(days);

  // Build the per-collection $match shared across pipelines. The
  // org filter (when present) lives here so every aggregation
  // picks it up uniformly — no risk of a pipeline forgetting the
  // scope.
  const orgFilter = query.org_id
    ? { orgId: new Types.ObjectId(query.org_id) }
    : {};

  // ── Sessions aggregation ──────────────────────────────────────
  // One $facet with three sub-pipelines so we get totals,
  // per-org, and time-series in a single round-trip. Each
  // sub-pipeline filters by session_source so ai vs pre_platform
  // separation is explicit.
  const sessionFacet = await AISession.aggregate<{
    totals: Array<{ ai_mins: number; pre_platform_mins: number }>;
    per_org: Array<{
      _id: Types.ObjectId;
      ai_mins: number;
      pre_platform_mins: number;
    }>;
    trend: Array<{ _id: Date; ai_mins: number; pre_platform_mins: number }>;
  }>([
    {
      $match: {
        createdAt: { $gte: from, $lte: to },
        session_source: { $in: ["ai_tutor", "pre_platform"] },
        ...orgFilter,
      },
    },
    {
      $project: {
        orgId: 1,
        createdAt: 1,
        // Map source → mins-bucket. teacher_consolidation is
        // explicitly excluded by the $match above, but the
        // $cond reads naturally as "if ai_tutor then ai_mins
        // else pre_platform_mins" with zero in the other slot.
        ai_mins: {
          $cond: [
            { $eq: ["$session_source", "ai_tutor"] },
            { $ifNull: ["$duration_mins", 0] },
            0,
          ],
        },
        pre_platform_mins: {
          $cond: [
            { $eq: ["$session_source", "pre_platform"] },
            { $ifNull: ["$duration_mins", 0] },
            0,
          ],
        },
      },
    },
    {
      $facet: {
        totals: [
          {
            $group: {
              _id: null,
              ai_mins: { $sum: "$ai_mins" },
              pre_platform_mins: { $sum: "$pre_platform_mins" },
            },
          },
        ],
        per_org: [
          {
            $group: {
              _id: "$orgId",
              ai_mins: { $sum: "$ai_mins" },
              pre_platform_mins: { $sum: "$pre_platform_mins" },
            },
          },
        ],
        trend: buildTrendPipeline(interval),
      },
    },
  ]);

  // ── Teacher-review aggregation ────────────────────────────────
  // Same $facet shape; one round-trip for totals + per-org +
  // trend. The TeacherReview schema uses `created_at` (snake)
  // explicitly because it's set by the service rather than
  // Mongoose's timestamps; the field appears verbatim in the
  // pipeline below.
  const reviewFacet = await TeacherReview.aggregate<{
    totals: Array<{ teacher_mins: number }>;
    per_org: Array<{ _id: Types.ObjectId; teacher_mins: number }>;
    trend: Array<{ _id: Date; teacher_mins: number }>;
  }>([
    {
      $match: {
        created_at: { $gte: from, $lte: to },
        ...(query.org_id ? { org_id: new Types.ObjectId(query.org_id) } : {}),
      },
    },
    {
      $project: {
        org_id: 1,
        created_at: 1,
        teacher_mins: { $ifNull: ["$duration_mins", 0] },
      },
    },
    {
      $facet: {
        totals: [
          {
            $group: {
              _id: null,
              teacher_mins: { $sum: "$teacher_mins" },
            },
          },
        ],
        per_org: [
          {
            $group: {
              _id: "$org_id",
              teacher_mins: { $sum: "$teacher_mins" },
            },
          },
        ],
        trend: buildReviewTrendPipeline(interval),
      },
    },
  ]);

  // ── Org-name resolution ───────────────────────────────────────
  // Build the union of org ids touched by either collection
  // (a session-heavy org may not have any reviews and vice versa)
  // and fetch their names in one round-trip.
  const orgIds = new Set<string>();
  for (const r of sessionFacet[0]?.per_org ?? [])
    orgIds.add((r._id as Types.ObjectId).toString());
  for (const r of reviewFacet[0]?.per_org ?? [])
    orgIds.add((r._id as Types.ObjectId).toString());

  const orgs =
    orgIds.size > 0
      ? await Organisation.find({
          _id: { $in: Array.from(orgIds).map((id) => new Types.ObjectId(id)) },
        })
          .select("name")
          .lean()
      : [];
  const orgNameById = new Map<string, string>(
    orgs.map((o) => [
      (o._id as Types.ObjectId).toString(),
      o.name ?? "(unnamed)",
    ]),
  );

  // ── Compose totals ────────────────────────────────────────────
  const totalAiMins = sessionFacet[0]?.totals[0]?.ai_mins ?? 0;
  const totalPrePlatformMins =
    sessionFacet[0]?.totals[0]?.pre_platform_mins ?? 0;
  const totalTeacherMins = reviewFacet[0]?.totals[0]?.teacher_mins ?? 0;

  const totals = buildBreakdown(
    totalAiMins / 60,
    totalPrePlatformMins / 60,
    totalTeacherMins / 60,
  );

  // ── Compose per-org ───────────────────────────────────────────
  // Merge the two per-org maps (sessions vs reviews) — an org
  // may appear in one but not the other.
  const perOrgMins = new Map<
    string,
    { ai: number; pre: number; teacher: number }
  >();
  for (const r of sessionFacet[0]?.per_org ?? []) {
    const key = (r._id as Types.ObjectId).toString();
    perOrgMins.set(key, {
      ai: r.ai_mins,
      pre: r.pre_platform_mins,
      teacher: 0,
    });
  }
  for (const r of reviewFacet[0]?.per_org ?? []) {
    const key = (r._id as Types.ObjectId).toString();
    const existing = perOrgMins.get(key) ?? { ai: 0, pre: 0, teacher: 0 };
    existing.teacher = r.teacher_mins;
    perOrgMins.set(key, existing);
  }
  const per_org = Array.from(perOrgMins.entries())
    .map(([orgId, m]) => ({
      org_id: orgId,
      org_name: orgNameById.get(orgId) ?? "(unnamed)",
      ...buildBreakdown(m.ai / 60, m.pre / 60, m.teacher / 60),
    }))
    .sort((a, b) => b.total_glh - a.total_glh);

  // ── Compose trend ─────────────────────────────────────────────
  // Build a bucket → mins-triple map keyed by ISO start.
  const trendMins = new Map<
    string,
    { ai: number; pre: number; teacher: number }
  >();
  for (const r of sessionFacet[0]?.trend ?? []) {
    const key = toIsoDay(r._id);
    trendMins.set(key, {
      ai: r.ai_mins,
      pre: r.pre_platform_mins,
      teacher: 0,
    });
  }
  for (const r of reviewFacet[0]?.trend ?? []) {
    const key = toIsoDay(r._id);
    const existing = trendMins.get(key) ?? { ai: 0, pre: 0, teacher: 0 };
    existing.teacher = r.teacher_mins;
    trendMins.set(key, existing);
  }
  // Enumerate every bucket boundary so the chart has a continuous
  // x-axis — empty buckets emit a row of zeros.
  const trend = enumerateBuckets(from, to, interval).map((bucket) => {
    const key = toIsoDay(bucket);
    const m = trendMins.get(key) ?? { ai: 0, pre: 0, teacher: 0 };
    return {
      bucket_start: key,
      ...buildBreakdown(m.ai / 60, m.pre / 60, m.teacher / 60),
    };
  });

  const response: GlhAnalyticsResponse = {
    period: {
      from: toIsoDay(from),
      to: toIsoDay(to),
      days,
    },
    totals,
    per_org,
    trend,
    trend_interval: interval,
  };
  return new ApiResponse(200, "GLH analytics", response);
};

// ─────────────────────────────────────────────────────────────────────
// Sub-pipeline builders
// ─────────────────────────────────────────────────────────────────────

/**
 * Trend grouping for the AISession pipeline. Groups by
 * bucket-start (daily / Monday) so the JS merge can match keys
 * via `toIsoDay`.
 */
const buildTrendPipeline = (
  interval: "daily" | "weekly",
): PipelineStage.FacetPipelineStage[] => {
  const dateTrunc =
    interval === "daily"
      ? { $dateTrunc: { date: "$createdAt", unit: "day" } }
      : {
          $dateTrunc: {
            date: "$createdAt",
            unit: "week",
            startOfWeek: "monday",
          },
        };

  return [
    {
      $group: {
        _id: dateTrunc,
        ai_mins: { $sum: "$ai_mins" },
        pre_platform_mins: { $sum: "$pre_platform_mins" },
      },
    },
    { $sort: { _id: 1 } },
  ];
};

/**
 * Mirror trend pipeline for TeacherReview. Different field name
 * (`created_at` vs `createdAt`) so we can't share the previous
 * builder verbatim.
 */
const buildReviewTrendPipeline = (
  interval: "daily" | "weekly",
): PipelineStage.FacetPipelineStage[] => {
  const dateTrunc =
    interval === "daily"
      ? { $dateTrunc: { date: "$created_at", unit: "day" } }
      : {
          $dateTrunc: {
            date: "$created_at",
            unit: "week",
            startOfWeek: "monday",
          },
        };

  return [
    {
      $group: {
        _id: dateTrunc,
        teacher_mins: { $sum: "$teacher_mins" },
      },
    },
    { $sort: { _id: 1 } },
  ];
};

// ─────────────────────────────────────────────────────────────────────
// Test exports
// ─────────────────────────────────────────────────────────────────────

export const __internals__ = {
  WEEKLY_THRESHOLD_DAYS,
  DEFAULT_WINDOW_DAYS,
  bucketStart,
  buildBreakdown,
  chooseInterval,
  enumerateBuckets,
  parseIsoDate,
  resolveWindow,
};
