import { Types, Document } from "mongoose";

/**
 * ROI calculator submission — Final Addendum §13.
 *
 * Captured on every POST to /api/public/roi-calculator/submit.
 * Used as a sales-intelligence feed (anonymous submissions
 * surface aggregate funnel signal; submissions with a contact
 * email feed Joey's outreach queue).
 *
 * Privacy posture
 * ===============
 *
 *   - `ip_address_hash` is a SHA-256 of (ip + IP_HASH_SALT).
 *     We never store the raw IP — rate-limiting + abuse-pattern
 *     analytics can work on the hash without exposing
 *     identifiable location data.
 *   - `user_agent` is stored verbatim — UA strings are not
 *     personally identifying on their own and help us spot
 *     bot floods.
 *   - `contact_email` + `contact_name` are nullable; an
 *     anonymous submission produces neither.
 */

export type RoiOrgType = "college" | "council" | "charity" | "employer";

export interface IRoiCalculatorSubmission extends Document {
  _id: Types.ObjectId;

  // ── User inputs ────────────────────────────────────────────────
  waiting_list_size: number;
  avg_asf_rate: number;
  org_name: string | null;
  org_type: RoiOrgType | null;
  current_throughput_per_year: number;

  // ── Optional contact details ───────────────────────────────────
  contact_email: string | null;
  contact_name: string | null;

  // ── Computed snapshot ──────────────────────────────────────────
  // Persisted alongside the inputs so a future change to the
  // calculation helper doesn't retroactively invalidate the
  // sales lead — Joey sees what the prospect saw.
  unclaimed_income_annual: number;
  payback_weeks: number | null;

  // ── Request metadata ───────────────────────────────────────────
  ip_address_hash: string;
  user_agent: string | null;

  // ── Sales follow-up — Final Addendum §13 ──────────────────────
  /**
   * Set when an Amber admin flags this lead as followed-up via
   * PATCH /admin/sales-intelligence/roi-submissions/:id/contacted.
   * Null until then; the admin table filters on this for the
   * "outstanding leads" backlog view.
   */
  contacted_at: Date | null;
  /** Amber admin who marked the row as contacted. Null until flagged. */
  contacted_by: Types.ObjectId | null;

  submitted_at: Date;
  createdAt: Date;
  updatedAt: Date;
}
