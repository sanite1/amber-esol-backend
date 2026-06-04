/**
 * ROI calculator submission service — Final Addendum §13.
 *
 *   POST /api/public/roi-calculator/submit
 *
 * Public, unauthenticated endpoint. The 20/hour/IP rate limiter
 * sits in the route layer. This service:
 *
 *   1. Re-runs the ROI calculation server-side so the persisted
 *      snapshot can never drift from a tampered client payload.
 *      The frontend's `computeRoi` and this server-side block use
 *      the SAME formula constants — the frontend can't lie to us
 *      about its own headline number.
 *   2. Hashes the IP with the platform's IP_HASH_SALT so the
 *      durable row never carries raw IP.
 *   3. Persists the RoiCalculatorSubmission.
 *   4. If a contact_email was provided, fires a content-light
 *      email-to-Joey on the notifications queue ("New ROI
 *      calculator submission from X — click here to see their
 *      inputs and follow up"). The submission ID is the
 *      deep-link target.
 *   5. Returns the submission id so the client can render a
 *      "we got it" confirmation.
 *
 * Why server-side recalculation
 * =============================
 *
 * Anyone can `curl` this endpoint with `unclaimed_income_annual:
 * 9999999999` — accepting client-supplied computed values would
 * poison the sales-intel feed. Recomputing on the server costs
 * a handful of multiplications and guarantees the row reflects
 * the spec.
 *
 * Email failure is non-fatal
 * ==========================
 *
 * If the notification enqueue fails, the submission still lands
 * (the durable artefact is the Mongo row; Joey can sweep recent
 * submissions on a daily basis as the safety net). The user
 * still sees a 200 — their successful action shouldn't fail
 * because a Redis queue had a hiccup.
 */

import { createHash } from "crypto";
import { Types } from "mongoose";
import ApiError from "../errors/apiError";
import ApiResponse from "../errors/apiResponse";
import RoiCalculatorSubmission from "../models/RoiCalculatorSubmission";
import { notificationsQueue } from "../queues";
import logger from "../config/logger";
import type { RoiOrgType } from "../interfaces/roiCalculatorSubmission.interface";

// ─────────────────────────────────────────────────────────────────────
// Pricing constants — MUST match
// src/modules/public/lib/roiCalculation.ts on the frontend so a
// server-side recompute produces the same number the user saw.
// ─────────────────────────────────────────────────────────────────────

const PRICING = {
  license_fee_base: 5_000,
  monthly_per_learner: 15,
} as const;

// ─────────────────────────────────────────────────────────────────────
// Public shapes
// ─────────────────────────────────────────────────────────────────────

export interface RoiCalculatorSubmitBody {
  waiting_list_size: number;
  avg_asf_rate: number;
  org_name?: string | null;
  org_type?: RoiOrgType | null;
  current_throughput_per_year?: number;
  contact_email?: string | null;
  contact_name?: string | null;
}

export interface RoiCalculatorSubmitInput {
  body: RoiCalculatorSubmitBody;
  /**
   * Caller-supplied. We hash it with the salt; raw IP never lands.
   * Sourced from `req.ip` at the route layer — Express's
   * `trust proxy` setting must be in place upstream for this to
   * carry the real client IP on Vercel / behind a load balancer.
   */
  ip_address: string;
  user_agent: string | null;
}

export interface RoiCalculatorSubmitResult {
  submission_id: string;
  /** True when an email-to-Joey was enqueued; false on anonymous submissions. */
  followup_email_enqueued: boolean;
}

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

/**
 * SHA-256 of `${ip}|${salt}`. The salt is required — without it
 * an attacker who knew the algorithm could rainbow-table a v4
 * IP space (only 2^32 entries) in seconds and recover the raw
 * address. The salt makes the hash a per-deployment value that
 * can't be rebuilt offline.
 */
const hashIp = (ip: string): string => {
  const salt = process.env.IP_HASH_SALT ?? "";
  if (!salt) {
    // Loud refusal at request time beats a silent salt-less hash.
    // The platform's deployment checklist sets IP_HASH_SALT at
    // boot; missing it is a config bug, not a request bug.
    throw new Error(
      "IP_HASH_SALT is not configured. Refusing to write an unsalted IP hash.",
    );
  }
  return createHash("sha256")
    .update(`${ip}|${salt}`)
    .digest("hex");
};

/**
 * Recompute the headline metrics server-side. Mirrors the
 * frontend's `computeRoi` for the two persisted fields. We don't
 * mirror the full breakdown because Joey doesn't need the
 * 5-year compounded total in the lead row — the headline +
 * payback are enough to triage.
 */
const recomputeSnapshot = (
  waitingListSize: number,
  avgAsfRate: number,
): { unclaimed_income_annual: number; payback_weeks: number | null } => {
  const unclaimed = waitingListSize * avgAsfRate;
  const projectSilkCost =
    PRICING.license_fee_base +
    waitingListSize * PRICING.monthly_per_learner * 12;
  const weeklyIncome = unclaimed / 52;
  const paybackRaw =
    weeklyIncome > 0 ? projectSilkCost / weeklyIncome : Number.POSITIVE_INFINITY;
  return {
    unclaimed_income_annual: Math.round(unclaimed),
    payback_weeks: Number.isFinite(paybackRaw) ? Math.round(paybackRaw) : null,
  };
};

// ─────────────────────────────────────────────────────────────────────
// Top-level entry
// ─────────────────────────────────────────────────────────────────────

export const submitRoiCalculatorService = async (
  input: RoiCalculatorSubmitInput,
): Promise<ApiResponse> => {
  const body = input.body;

  // ── Defensive validation (Joi at route already covers shape) ──
  if (typeof body?.waiting_list_size !== "number" || body.waiting_list_size <= 0) {
    throw new ApiError(400, "waiting_list_size must be a positive number");
  }
  if (typeof body.avg_asf_rate !== "number" || body.avg_asf_rate <= 0) {
    throw new ApiError(400, "avg_asf_rate must be a positive number");
  }

  // ── Server-side recompute (never trust client maths) ──────────
  const snapshot = recomputeSnapshot(
    body.waiting_list_size,
    body.avg_asf_rate,
  );

  // ── Persist ───────────────────────────────────────────────────
  let submission;
  try {
    submission = await RoiCalculatorSubmission.create({
      waiting_list_size: body.waiting_list_size,
      avg_asf_rate: body.avg_asf_rate,
      org_name: body.org_name?.trim() || null,
      org_type: body.org_type ?? null,
      current_throughput_per_year:
        typeof body.current_throughput_per_year === "number" &&
        body.current_throughput_per_year >= 0
          ? body.current_throughput_per_year
          : 0,
      contact_email: body.contact_email?.trim().toLowerCase() || null,
      contact_name: body.contact_name?.trim() || null,
      unclaimed_income_annual: snapshot.unclaimed_income_annual,
      payback_weeks: snapshot.payback_weeks,
      ip_address_hash: hashIp(input.ip_address),
      user_agent: input.user_agent,
      submitted_at: new Date(),
    });
  } catch (err) {
    logger.error(
      {
        err: (err as Error).message,
        org_name: body.org_name,
      },
      "submitRoiCalculator: Mongo create failed",
    );
    throw new ApiError(500, "Could not save your submission. Please try again.");
  }

  // ── Email-to-Joey (best-effort) ──────────────────────────────
  let followup_email_enqueued = false;
  if (body.contact_email && body.contact_email.trim().length > 0) {
    try {
      await notificationsQueue.add(
        "roi-calculator-submission",
        {
          channel: "email",
          // The notification worker resolves Joey's mailbox from
          // the `recipientId` lookup; "amber-admin" is the
          // platform convention for admin-broadcast emails (same
          // string used by the safeguarding + postcode-refresh
          // notifications).
          recipientId: "amber-admin",
          type: "roi_calculator_submission",
          payload: {
            submission_id: (submission._id as Types.ObjectId).toString(),
            org_name: submission.org_name,
            org_type: submission.org_type,
            contact_email: submission.contact_email,
            contact_name: submission.contact_name,
            unclaimed_income_annual: submission.unclaimed_income_annual,
            payback_weeks: submission.payback_weeks,
            waiting_list_size: submission.waiting_list_size,
            avg_asf_rate: submission.avg_asf_rate,
            current_throughput_per_year: submission.current_throughput_per_year,
            // Deep link for Joey — admin-side UI lives at
            // /admin/roi-submissions/:id (Phase 27 will build the
            // page). Until then the URL 404s; better than no
            // affordance in the email.
            admin_url: `https://app.ambertraining.co.uk/admin/roi-submissions/${(submission._id as Types.ObjectId).toString()}`,
            submitted_at: submission.submitted_at.toISOString(),
          },
        },
        { priority: 5 },
      );
      followup_email_enqueued = true;
    } catch (err) {
      // Non-fatal — the row is the durable artefact. Joey can
      // sweep recent submissions if email enqueue drops.
      logger.error(
        {
          err: (err as Error).message,
          submission_id: (submission._id as Types.ObjectId).toString(),
        },
        "submitRoiCalculator: follow-up email enqueue failed (submission committed)",
      );
    }
  }

  logger.info(
    {
      submission_id: (submission._id as Types.ObjectId).toString(),
      org_name: submission.org_name,
      org_type: submission.org_type,
      has_contact: Boolean(submission.contact_email),
      followup_email_enqueued,
    },
    "submitRoiCalculator: complete",
  );

  const result: RoiCalculatorSubmitResult = {
    submission_id: (submission._id as Types.ObjectId).toString(),
    followup_email_enqueued,
  };
  return new ApiResponse(201, "Submission received", result);
};

export const __internals__ = { hashIp, recomputeSnapshot, PRICING };
