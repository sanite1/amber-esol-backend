/**
 * Mark a TeacherMessage as read — Final Addendum §11.
 *
 *   PATCH /api/esol/messages/:id/read
 *
 * Learner-facing read-receipt write. Used by the future messages-
 * list page (Phase 25) and any client that surfaces a tutor message
 * (e.g. an in-product reader, the unread banner click-through).
 *
 * Pipeline
 * ========
 *
 *   1. Validate the message id shape.
 *   2. Load the TeacherMessage. 404 when missing.
 *   3. OWNERSHIP GATE — `learner_id === caller_id`. 404 (not 403)
 *      when the message belongs to another learner; leaking
 *      "this message id exists, just not yours" would let a
 *      learner enumerate the global TeacherMessage space.
 *   4. Idempotency: if `read_at` is already set, return the
 *      existing row with status 200. No second mutation, no
 *      second audit row.
 *   5. Atomic findOneAndUpdate guarded on `read_at: null` — wins
 *      one writer per row even under simultaneous PATCHes from
 *      two tabs (the second sees `read_at` already set and falls
 *      through to the idempotent return path).
 *   6. Audit row `teacher_message_read` — actor_type "learner",
 *      learner_id = caller, org_id stamped from the message.
 *
 * Why 404 not 403 on ownership mismatch
 * =====================================
 *
 * Same disambiguation rule the teacher routes apply: returning
 * 403 confirms the resource exists, which is information
 * disclosure. 404 keeps "doesn't exist" and "isn't yours"
 * indistinguishable to an unauthorised caller.
 */

import { Types } from "mongoose";
import ApiError from "../errors/apiError";
import ApiResponse from "../errors/apiResponse";
import TeacherMessage from "../models/TeacherMessage";
import { writeAuditLog } from "./auditLog.service";

// ─────────────────────────────────────────────────────────────────────
// Public shapes
// ─────────────────────────────────────────────────────────────────────

export interface MarkMessageReadResult {
  _id: string;
  teacher_id: string;
  learner_id: string;
  org_id: string;
  message_text: string;
  original_text: string | null;
  language: string;
  sent_at: string;
  read_at: string;
  trigger: string;
  /** True when this call performed the mutation; false when the message was already read. */
  newly_marked: boolean;
}

// ─────────────────────────────────────────────────────────────────────
// Top-level entry
// ─────────────────────────────────────────────────────────────────────

export const markMessageReadService = async (
  message_id: string,
  learner_id: string,
): Promise<ApiResponse> => {
  if (!message_id || !Types.ObjectId.isValid(message_id)) {
    throw new ApiError(400, "message id must be a valid ObjectId");
  }
  if (!learner_id || !Types.ObjectId.isValid(learner_id)) {
    throw new ApiError(400, "Authenticated learner id required");
  }
  const messageObjectId = new Types.ObjectId(message_id);
  const learnerObjectId = new Types.ObjectId(learner_id);

  // ── 1. Load + ownership gate ──────────────────────────────────
  const existing = await TeacherMessage.findById(messageObjectId).lean();
  if (!existing) {
    throw new ApiError(404, "Message not found");
  }
  if ((existing.learner_id as Types.ObjectId).toString() !== learner_id) {
    // Opaque 404 — see service-file rationale.
    throw new ApiError(404, "Message not found");
  }

  // ── 2. Already-read fast path (idempotent) ────────────────────
  if (existing.read_at) {
    return new ApiResponse(
      200,
      "Message already marked as read",
      buildResult(existing, /* newlyMarked */ false),
    );
  }

  // ── 3. Atomic flip — guard on read_at: null so a second
  //     concurrent PATCH sees no-match and falls back to the
  //     idempotent return below.
  const now = new Date();
  const updated = await TeacherMessage.findOneAndUpdate(
    { _id: messageObjectId, learner_id: learnerObjectId, read_at: null },
    { $set: { read_at: now } },
    { new: true },
  ).lean();

  if (!updated) {
    // Either the row was deleted in the millisecond between the
    // load and the update (vanishingly unlikely) OR a concurrent
    // PATCH won the race. In either concurrent case, re-fetch
    // and return the row — the read state IS now true, which is
    // what the caller wanted.
    const refreshed = await TeacherMessage.findById(messageObjectId).lean();
    if (!refreshed) {
      throw new ApiError(404, "Message not found");
    }
    return new ApiResponse(
      200,
      "Message already marked as read",
      buildResult(refreshed, false),
    );
  }

  // ── 4. Audit row — only on the first flip ────────────────────
  // The reason carries the trigger axis so an auditor seeing a
  // "read" event for an auto-sent re-engagement message can tell
  // the difference from a manual tutor note without joining the
  // TeacherMessage row.
  await writeAuditLog({
    actor_type: "learner",
    actor_id: learner_id,
    org_id: (updated.org_id as Types.ObjectId).toString(),
    learner_id,
    action: "teacher_message_read",
    before_state: { read_at: null },
    after_state: { read_at: now.toISOString() },
    reason:
      `Learner acknowledged a tutor message ` +
      `(trigger=${(updated as { trigger?: string }).trigger ?? "manual"}, ` +
      `language=${(updated as { language?: string }).language ?? "en"}).`,
  });

  return new ApiResponse(
    200,
    "Message marked as read",
    buildResult(updated, true),
  );
};

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

const buildResult = (
  doc: Record<string, unknown>,
  newlyMarked: boolean,
): MarkMessageReadResult => {
  const sentAtRaw = doc.sent_at as Date | string;
  const readAtRaw = doc.read_at as Date | string | null;
  return {
    _id: (doc._id as Types.ObjectId).toString(),
    teacher_id: (doc.teacher_id as Types.ObjectId).toString(),
    learner_id: (doc.learner_id as Types.ObjectId).toString(),
    org_id: (doc.org_id as Types.ObjectId).toString(),
    message_text: doc.message_text as string,
    original_text: (doc.original_text as string | null) ?? null,
    language: (doc.language as string) ?? "en",
    sent_at:
      sentAtRaw instanceof Date
        ? sentAtRaw.toISOString()
        : new Date(sentAtRaw).toISOString(),
    // Guarded above — read_at is non-null on every code path that
    // reaches buildResult (we either skipped early on idempotent
    // already-read OR we just set it).
    read_at:
      readAtRaw instanceof Date
        ? readAtRaw.toISOString()
        : new Date(readAtRaw as string).toISOString(),
    trigger: (doc.trigger as string) ?? "manual",
    newly_marked: newlyMarked,
  };
};
