import { Types, Document } from "mongoose";

/**
 * TurnLog — one row per learner message hitting POST /api/esol/session/turn.
 *
 * Written BEFORE any Gemini call, so we have the original message
 * captured even if a downstream step fails. Used for:
 *   - Compliance audit (Ofsted: "show me every message a learner ever
 *     sent in their AI sessions")
 *   - Safeguarding review: the DSL filters by `served_path` to see
 *     which messages tripped a safeguarding response
 *   - Post-hoc evidence reconstruction if AuditLog drift loses context
 *
 * Append-only — never updated or deleted in place.
 */

export type TurnServedPath =
  | "safeguarding_precache"      // SafeguardingDetector matched, Gemini never called
  | "gemini"                     // normal Gemini turn served
  | "ai_only_safeguarding";      // Gemini flagged but keyword scan didn't — pre-cache served, alert raised

export interface ITurnLog extends Document {
  _id: Types.ObjectId;
  session_id: Types.ObjectId;
  learner_id: Types.ObjectId;
  org_id: Types.ObjectId;
  /** The learner's input verbatim. NOT scrubbed at this layer — raw
   *  is what we want for audit. PII scrubbing happens before the
   *  text reaches Gemini, not before it reaches this log. */
  message: string;
  /** Outcome of the SafeguardingDetector scan; persisted regardless
   *  of `served_path` so an auditor can see why a turn went each way. */
  safeguarding_scan: {
    triggered: boolean;
    category: string | null;
    matched_pattern: string | null;
  };
  served_path: TurnServedPath;
  /** Which Gemini schema flag fired, if any. Populated only when
   *  `served_path === "gemini"` or `"ai_only_safeguarding"`. */
  gemini_safeguarding_category: string | null;
  timestamp: Date;
}
