import { Types, Document } from "mongoose";

export type SafeguardingAlertLevel = "low" | "medium" | "high" | "critical";
export type SafeguardingAlertStatus =
  | "open"
  | "reviewed"
  | "escalated"
  | "resolved"
  | "dismissed";

/**
 * Pre-cache safeguarding alert document.
 *
 * Field notes (brief Function 10):
 *   - messageContentHash: SHA-256 of the original learner message. The
 *     alert collection NEVER stores the cleartext — only this digest.
 *     If a reviewer needs the disclosure text, they correlate to
 *     TurnLog by (learnerId, sessionId, timestamp); the digest
 *     confirms the same row.
 *   - triggerCategory: which safeguarding category fired (self_harm,
 *     domestic_abuse, …). Lets the DSL filter and the dashboard chart
 *     trends without parsing TurnLog payloads.
 *   - triggerSource: "keyword" (pre-Gemini SafeguardingDetector) or
 *     "ai_only" (Gemini's own safeguarding_flag, when the keyword scan
 *     missed). Both are real safeguarding events — the distinction is
 *     diagnostic, not severity-bearing.
 *
 * No other field on this document may carry message content. If a
 * future field needs to, route it to TurnLog instead.
 */
export type SafeguardingAlertSource = "keyword" | "ai_only";

export interface ISafeguardingAlert extends Document {
  _id: Types.ObjectId;
  learnerId: Types.ObjectId;
  orgId: Types.ObjectId;
  sessionId: Types.ObjectId;
  alertLevel: SafeguardingAlertLevel;
  /** SHA-256 hex (64 chars). Brief calls this message_content_hash. */
  messageContentHash: string;
  /**
   * F22 hardening — the raw disclosure text, ENCRYPTED at rest
   * (safeguardingCrypto / cryptr). Cleartext never touches the DB; an
   * authorised DSL read decrypts on demand. Null when no encryption key
   * is configured (the raw then stays in the append-only TurnLog and a
   * boot warning fires) or for the secondary ai_only path.
   */
  rawInputEncrypted?: string | null;
  triggerCategory?: string;
  triggerSource?: SafeguardingAlertSource;
  claudeReasoning?: string;
  reviewedBy?: Types.ObjectId;
  reviewedAt?: Date;
  status: SafeguardingAlertStatus;
  resolution?: string;
  /**
   * Brief Function 10/15 admin resolution lifecycle. Snake_case in the
   * brief (`resolved_at`, `resolved_by`, `resolution_notes`), camelCase
   * here. Set together via PATCH /api/admin/safeguarding/:id; clearing
   * back to null is intentionally not supported (resolutions are
   * monotonic — only an Amber admin can resolve, never un-resolve).
   */
  resolvedAt?: Date | null;
  resolvedBy?: Types.ObjectId | null;
  resolutionNotes?: string | null;
  notificationSentAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface IReviewAlertRequest {
  status: SafeguardingAlertStatus;
  resolution?: string;
}
