/**
 * Learner messages controller — Final Addendum §11.
 *
 *   GET /api/esol/messages/unread
 *
 * Thin adapter — pulls `req.user._id` and hands it to the service.
 * The learner id MUST come from the JWT-rehydrated user, NEVER
 * from a query/body parameter: a learner can only ever read their
 * own messages.
 */

import { ExpressFunction } from "../interfaces/helper.interface";
import { getLearnerUnreadMessagesService } from "../services/learnerUnreadMessages.service";
import { markMessageReadService } from "../services/learnerMarkMessageRead.service";

/** Shared shape extractor — req.user is { id } in some places, { _id } in others. */
const readLearnerId = (req: Parameters<ExpressFunction>[0]): string => {
  const userAny = req.user as { id?: string; _id?: string } | undefined;
  return userAny?._id ?? userAny?.id ?? "";
};

export const getLearnerUnreadMessages: ExpressFunction = async (
  req,
  res,
  next,
) => {
  try {
    const result = await getLearnerUnreadMessagesService(readLearnerId(req));
    return res.status(result.statusCode).json({
      message: result.message,
      data: result.data,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * PATCH /api/esol/messages/:id/read — Final Addendum §11.
 *
 * Flip a TeacherMessage's `read_at` to now. Idempotent on repeat
 * calls (already-read returns 200 with the existing row). The
 * ownership gate (`learner_id === caller_id`) lives in the
 * service; a wrong-owner request returns an opaque 404 to keep
 * "exists but not yours" indistinguishable from "doesn't exist".
 */
export const markMessageAsRead: ExpressFunction = async (req, res, next) => {
  try {
    const { id } = req.params as { id: string };
    const result = await markMessageReadService(id, readLearnerId(req));
    return res.status(result.statusCode).json({
      message: result.message,
      data: result.data,
    });
  } catch (err) {
    next(err);
  }
};
