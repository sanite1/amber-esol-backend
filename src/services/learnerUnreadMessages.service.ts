/**
 * Learner unread-messages service — Final Addendum §11.
 *
 *   GET /api/esol/messages/unread
 *
 * Returns the calling learner's unread TeacherMessage rows so the
 * learner-home banner can render "you have N unread messages".
 *
 * Why a dedicated endpoint rather than relying on
 * /api/esol/session/start?
 * ============================================================
 *
 * The session-start handler already returns `unread_messages` (Phase
 * 9.6), and the AI Tutor frontend renders them before the chat begins
 * (Phase 9.8). That covers learners who jump straight into a
 * scenario — but a learner who lands on the dashboard and doesn't
 * immediately start a session would never see the modal.
 *
 * The dashboard banner needs a separate, cheap GET that the home
 * page can poll on mount + visibility-change. Same TeacherMessage
 * query, no session-start side effects (idempotency lock, pathway-
 * override expiry, etc.).
 *
 * Read receipts
 * =============
 *
 * This endpoint is READ-ONLY. It does NOT mutate `read_at` — a
 * "viewed the banner" event isn't the same as "viewed the message
 * content." A dedicated mark-as-read endpoint will land when the
 * full messages-list page ships; until then messages stay unread
 * until the learner actively acknowledges them somewhere else
 * (or never, if the future page chooses to auto-mark on render).
 *
 * Privacy invariants
 * ==================
 *
 *   1. The endpoint reads the learner id from `req.user._id` —
 *      never from a query string. No learner can ever read
 *      another learner's messages via this route.
 *   2. The response carries the full `message_text` (the
 *      learner is the intended recipient). Teacher identity is
 *      reduced to `{ id, firstname, lastname }` so the banner can
 *      render "Sarah sent you a message" without exposing the
 *      teacher's email / profile picture / dbs status.
 */

import { Types } from "mongoose";
import ApiResponse from "../errors/apiResponse";
import ApiError from "../errors/apiError";
import TeacherMessage from "../models/TeacherMessage";

// ─────────────────────────────────────────────────────────────────────
// Public shapes
// ─────────────────────────────────────────────────────────────────────

export interface UnreadMessageRow {
  _id: string;
  teacher_id: string;
  teacher_firstname: string | null;
  teacher_lastname: string | null;
  message_text: string;
  original_text: string | null;
  language: string;
  sent_at: string;
  trigger: string;
}

export interface UnreadMessagesResponse {
  count: number;
  messages: UnreadMessageRow[];
}

// ─────────────────────────────────────────────────────────────────────
// Top-level entry
// ─────────────────────────────────────────────────────────────────────

const MAX_UNREAD_RETURNED = 50;

export const getLearnerUnreadMessagesService = async (
  learner_id: string,
): Promise<ApiResponse> => {
  if (!learner_id || !Types.ObjectId.isValid(learner_id)) {
    throw new ApiError(400, "Authenticated learner id required");
  }
  const learnerObjectId = new Types.ObjectId(learner_id);

  // Sort by sent_at desc (newest first) — the banner shows the
  // count + the most-recent sender's name, and the click-through
  // page will likely scroll-up = newest. Cap at 50 to keep the
  // payload small; a learner with >50 unread has bigger problems
  // than what the banner can solve, and the future messages-list
  // page can paginate.
  const docs = await TeacherMessage.find({
    learner_id: learnerObjectId,
    read_at: null,
  })
    .sort({ sent_at: -1 })
    .limit(MAX_UNREAD_RETURNED)
    .populate("teacher_id", "firstname lastname")
    .lean();

  // A cheap parallel count avoids the "we showed 50 unread but
  // there are actually 73" surprise on the banner — the response
  // surfaces the true count separately.
  const trueCount = await TeacherMessage.countDocuments({
    learner_id: learnerObjectId,
    read_at: null,
  });

  const messages: UnreadMessageRow[] = docs.map((d) => {
    const teacher = (
      d as unknown as {
        teacher_id?:
          | { _id: Types.ObjectId; firstname?: string; lastname?: string }
          | Types.ObjectId;
      }
    ).teacher_id;
    const isPopulated =
      teacher !== null && typeof teacher === "object" && "_id" in teacher;
    const teacherIdStr = isPopulated
      ? (teacher as { _id: Types.ObjectId })._id.toString()
      : ((teacher as Types.ObjectId | undefined)?.toString() ?? "");
    return {
      _id: (d._id as Types.ObjectId).toString(),
      teacher_id: teacherIdStr,
      teacher_firstname: isPopulated
        ? ((teacher as { firstname?: string }).firstname ?? null)
        : null,
      teacher_lastname: isPopulated
        ? ((teacher as { lastname?: string }).lastname ?? null)
        : null,
      message_text: (d as { message_text: string }).message_text,
      original_text:
        (d as { original_text?: string | null }).original_text ?? null,
      language: (d as { language?: string }).language ?? "en",
      sent_at: (() => {
        // `sent_at` is a Date on the lean doc. The redundant
        // instanceof + `new Date(...)` fallback handles the edge
        // case of a legacy import that wrote a string into the
        // field before the schema enforced Date.
        const raw = (d as { sent_at: Date | string }).sent_at;
        if (raw instanceof Date) return raw.toISOString();
        return new Date(raw as unknown as string).toISOString();
      })(),
      trigger: (d as { trigger?: string }).trigger ?? "manual",
    };
  });

  const result: UnreadMessagesResponse = {
    count: trueCount,
    messages,
  };
  return new ApiResponse(200, "Unread messages", result);
};
