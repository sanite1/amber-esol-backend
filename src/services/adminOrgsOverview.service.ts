/**
 * Amber-admin all-orgs overview — brief Function 15 To-Do 1.
 *
 * Single Mongo aggregation that produces, for every Organisation:
 *   - identity (name, type, contract dates, demo flag)
 *   - learner counts (total, active in last 7 days)
 *   - GLH this calendar month (AISession.duration_mins, all sources)
 *   - revenue this calendar month (SaaS fee + ESOL session fees)
 *   - derived billing_status
 *
 * Plus headline aggregates across all orgs.
 *
 * Design notes
 *
 * - One trip to Mongo: the per-org rollups happen in sub-pipelines under
 *   $lookup, then the cross-org aggregates are computed in JS (N orgs is
 *   bounded; we'd $facet at scale).
 * - The "this month" window is the LOCAL Europe/London calendar month
 *   (where Amber operates), boundaries computed once at the service
 *   entry so the pipeline gets fixed Date instances rather than
 *   $$NOW-derived ranges (cheaper for the query planner; easier to
 *   reason about across DST shifts).
 * - billing_status is derived in the application layer rather than
 *   stored — the source-of-truth signals (`billing_active`,
 *   `contractEnd`, contract presence) are already on the Org doc.
 * - SaaS revenue uses `monthly_fee_per_head × learner_count` for the
 *   month — a flat per-head subscription, prorated only at the contract
 *   level (Stripe handles mid-month joiners on their side). Demo orgs
 *   are excluded from the revenue total: they ARE included in the row
 *   list (with `is_demo: true` for the badge) but their per-org
 *   revenue is forced to 0 so they don't skew the headline numbers.
 * - Session fees come from completed `esol_consolidation` bookings
 *   where `completedAt` falls in the month. We sum `price` directly —
 *   the booking pipeline already applied `Organisation.esol_session_rate`
 *   when the row was created.
 */

import { Types } from "mongoose";
import Organisation from "../models/Organisation";
import User from "../models/User";
import AISession from "../models/AISession";
import Booking from "../models/Booking";
import logger from "../config/logger";

// ─────────────────────────────────────────────────────────────────────
// Public response shapes
// ─────────────────────────────────────────────────────────────────────

export type BillingStatus =
  | "active"
  | "paused"
  | "lapsed_contract"
  | "no_contract";

export interface AdminOrgsOverviewRow {
  org_id: string;
  name: string;
  type: string | null;
  is_demo: boolean;
  contract_start: string | null;
  contract_end: string | null;
  learner_count: number;
  active_learner_count: number;
  total_glh: number;
  saas_fee_this_month: number;
  session_fees_this_month: number;
  revenue_this_month: number;
  billing_status: BillingStatus;
  billing_active: boolean;
}

export interface AdminOrgsOverviewAggregates {
  total_orgs: number;
  total_learners: number;
  total_glh_this_month: number;
  total_revenue_this_month: number;
}

export interface AdminOrgsOverviewResponse {
  generated_at: string;
  period: { month_start: string; month_end: string };
  orgs: AdminOrgsOverviewRow[];
  aggregates: AdminOrgsOverviewAggregates;
}

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

/**
 * Start and end of the current calendar month in UTC. Amber operates
 * in Europe/London — for the MVP, GMT/BST drift across a month boundary
 * is within tolerance for a "this month" headline (the affected window
 * is at most one hour either side of midnight, and the figures here
 * aren't financial-statements-grade).
 */
const monthBoundsUtc = (now: Date): { monthStart: Date; monthEnd: Date } => {
  const monthStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0),
  );
  const monthEnd = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth() + 1,
      1,
      0,
      0,
      0,
      0,
    ) - 1,
  );
  return { monthStart, monthEnd };
};

const sevenDaysBefore = (now: Date): Date =>
  new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

const round1 = (n: number): number => Math.round(n * 10) / 10;
const round2 = (n: number): number => Math.round(n * 100) / 100;

const deriveBillingStatus = (input: {
  billing_active: boolean;
  contractEnd: Date | null;
  contractStart: Date | null;
  now: Date;
}): BillingStatus => {
  if (input.billing_active === false) return "paused";
  if (!input.contractStart && !input.contractEnd) return "no_contract";
  if (input.contractEnd && input.contractEnd.getTime() < input.now.getTime()) {
    return "lapsed_contract";
  }
  return "active";
};

// ─────────────────────────────────────────────────────────────────────
// Aggregation pipeline + JS rollup
// ─────────────────────────────────────────────────────────────────────

/**
 * Internal row shape that comes back from the Mongo pipeline before
 * we derive billing_status and the revenue totals.
 */
interface PipelineRow {
  _id: Types.ObjectId;
  name: string;
  type: string | null;
  is_demo: boolean;
  billing_active: boolean;
  monthly_fee_per_head: number | null;
  contractStart: Date | null;
  contractEnd: Date | null;
  learner_count: number;
  active_learner_count: number;
  total_mins_this_month: number;
  session_fees_this_month: number;
}

export const getAdminOrgsOverview = async (): Promise<AdminOrgsOverviewResponse> => {
  const now = new Date();
  const { monthStart, monthEnd } = monthBoundsUtc(now);
  const sevenDaysAgo = sevenDaysBefore(now);

  // The $lookup `from` strings are the actual Mongo collection names.
  // Reading them off the model rather than hardcoding "users" etc.
  // protects us from any future custom collection naming.
  const usersColl = User.collection.name;
  const sessionsColl = AISession.collection.name;
  const bookingsColl = Booking.collection.name;

  const rows: PipelineRow[] = await Organisation.aggregate([
    // No filter — demo orgs ARE included (with their badge). The
    // service-layer reduction zeroes out demo revenue afterwards so
    // headline aggregates aren't polluted.
    { $sort: { name: 1 } },

    // ── Learners — total + active in last 7 days ──────────────────
    {
      $lookup: {
        from: usersColl,
        let: { orgId: "$_id" },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ["$orgId", "$$orgId"] },
                  { $eq: ["$role", "student"] },
                ],
              },
            },
          },
          {
            $group: {
              _id: null,
              total: { $sum: 1 },
              active7d: {
                $sum: {
                  $cond: [
                    {
                      $and: [
                        { $ifNull: ["$last_session_at", false] },
                        { $gte: ["$last_session_at", sevenDaysAgo] },
                      ],
                    },
                    1,
                    0,
                  ],
                },
              },
            },
          },
        ],
        as: "learners",
      },
    },

    // ── AI sessions — total mins this month ───────────────────────
    {
      $lookup: {
        from: sessionsColl,
        let: { orgId: "$_id" },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ["$orgId", "$$orgId"] },
                  { $gte: ["$createdAt", monthStart] },
                  { $lte: ["$createdAt", monthEnd] },
                ],
              },
            },
          },
          {
            $group: {
              _id: null,
              total_mins: {
                $sum: { $ifNull: ["$duration_mins", 0] },
              },
            },
          },
        ],
        as: "sessions",
      },
    },

    // ── Bookings — ESOL session fees this month ───────────────────
    // Only completed esol_consolidation bookings count. Cancelled or
    // no-shows aren't billed; trial/regular bookings are unrelated to
    // org revenue (they go to the teacher directly via Stripe).
    {
      $lookup: {
        from: bookingsColl,
        let: { orgId: "$_id" },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ["$orgId", "$$orgId"] },
                  { $eq: ["$type", "esol_consolidation"] },
                  { $eq: ["$status", "completed"] },
                  { $gte: ["$completedAt", monthStart] },
                  { $lte: ["$completedAt", monthEnd] },
                ],
              },
            },
          },
          {
            $group: {
              _id: null,
              total_price: { $sum: { $ifNull: ["$price", 0] } },
            },
          },
        ],
        as: "bookings",
      },
    },

    // ── Project to a flat row shape ───────────────────────────────
    {
      $project: {
        _id: 1,
        name: 1,
        type: 1,
        is_demo: 1,
        billing_active: 1,
        monthly_fee_per_head: 1,
        contractStart: 1,
        contractEnd: 1,
        learner_count: { $ifNull: [{ $arrayElemAt: ["$learners.total", 0] }, 0] },
        active_learner_count: {
          $ifNull: [{ $arrayElemAt: ["$learners.active7d", 0] }, 0],
        },
        total_mins_this_month: {
          $ifNull: [{ $arrayElemAt: ["$sessions.total_mins", 0] }, 0],
        },
        session_fees_this_month: {
          $ifNull: [{ $arrayElemAt: ["$bookings.total_price", 0] }, 0],
        },
      },
    },
  ]);

  // ── JS-layer rollups ────────────────────────────────────────────
  let total_learners = 0;
  let total_glh_this_month = 0;
  let total_revenue_this_month = 0;

  const orgs: AdminOrgsOverviewRow[] = rows.map((r) => {
    const total_glh = round1((r.total_mins_this_month ?? 0) / 60);

    // SaaS revenue = monthly_fee_per_head × learner_count.
    // Null fee → 0 (org not on a per-head SaaS plan). Demo orgs are
    // forced to zero regardless so they can't skew the totals.
    const saasFeeRaw =
      r.is_demo === true
        ? 0
        : (r.monthly_fee_per_head ?? 0) * (r.learner_count ?? 0);
    const sessionFeesRaw = r.is_demo === true ? 0 : r.session_fees_this_month ?? 0;
    const revenueRaw = saasFeeRaw + sessionFeesRaw;

    const billing_status = deriveBillingStatus({
      billing_active: r.billing_active !== false,
      contractEnd: r.contractEnd ?? null,
      contractStart: r.contractStart ?? null,
      now,
    });

    // Headline aggregates exclude demo orgs from revenue (above) but
    // include them in learner / GLH totals — that's a deliberate
    // product choice so the "total platform usage" panel doesn't
    // pretend demo activity doesn't exist.
    total_learners += r.learner_count ?? 0;
    total_glh_this_month += total_glh;
    total_revenue_this_month += revenueRaw;

    return {
      org_id: r._id.toString(),
      name: r.name,
      type: r.type ?? null,
      is_demo: Boolean(r.is_demo),
      contract_start: r.contractStart ? r.contractStart.toISOString() : null,
      contract_end: r.contractEnd ? r.contractEnd.toISOString() : null,
      learner_count: r.learner_count ?? 0,
      active_learner_count: r.active_learner_count ?? 0,
      total_glh,
      saas_fee_this_month: round2(saasFeeRaw),
      session_fees_this_month: round2(sessionFeesRaw),
      revenue_this_month: round2(revenueRaw),
      billing_status,
      billing_active: r.billing_active !== false,
    };
  });

  const aggregates: AdminOrgsOverviewAggregates = {
    total_orgs: orgs.length,
    total_learners,
    total_glh_this_month: round1(total_glh_this_month),
    total_revenue_this_month: round2(total_revenue_this_month),
  };

  logger.info(
    {
      total_orgs: aggregates.total_orgs,
      total_learners: aggregates.total_learners,
      total_glh_this_month: aggregates.total_glh_this_month,
      total_revenue_this_month: aggregates.total_revenue_this_month,
    },
    "getAdminOrgsOverview: complete",
  );

  return {
    generated_at: now.toISOString(),
    period: {
      month_start: monthStart.toISOString(),
      month_end: monthEnd.toISOString(),
    },
    orgs,
    aggregates,
  };
};

// Re-export internals for unit tests.
export const __internals__ = {
  monthBoundsUtc,
  sevenDaysBefore,
  deriveBillingStatus,
  round1,
  round2,
};
