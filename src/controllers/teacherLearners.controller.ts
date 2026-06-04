/**
 * Teacher learner-list controller — Final Addendum §9, Todo 22.3.
 *
 *   GET /api/teacher/learners
 *
 * Thin adapter. Auth + role gate live at the route layer; this
 * controller pulls `teacher_id` from `req.teacher_context` (set by
 * `requireTeacherContext`) and hands it explicitly to the service.
 *
 * The teacher_id MUST come from `teacher_context`, NEVER from
 * `req.user.id` directly — same invariant `requireOrgContext`
 * enforces for `org_id`. Reading from the context makes the
 * scoping decision auditable at code review: a service call site
 * with `listTeacherLearnersService(req.teacher_context.teacher_id, …)`
 * shows the scope clearly, whereas a `req.user.id` reference
 * hides it inside business logic.
 */

import { ExpressFunction } from "../interfaces/helper.interface";
import {
  listTeacherLearnersService,
  ListTeacherLearnersQuery,
} from "../services/teacherLearners.service";
import { getTeacherLearnerDetailService } from "../services/teacherLearnerDetail.service";
import {
  logTeacherReviewService,
  LogTeacherReviewBody,
} from "../services/teacherReviewLog.service";
import {
  setPathwayOverrideService,
  SetPathwayOverrideBody,
} from "../services/teacherPathwayOverride.service";
import {
  signOffStage5ReviewService,
  SignOffStage5ReviewBody,
} from "../services/teacherRarpaSignoff.service";
import {
  sendTeacherMessageService,
  SendTeacherMessageBody,
} from "../services/teacherMessageSend.service";
import {
  previewTeacherMessageTranslationService,
  PreviewTranslationBody,
} from "../services/teacherMessagePreview.service";
import {
  updateAutoReEngagementService,
  UpdateAutoReEngagementBody,
} from "../services/teacherPreferences.service";
import User from "../models/User";

const readTeacherId = (req: Parameters<ExpressFunction>[0]): string =>
  (req as typeof req & { teacher_context?: { teacher_id?: string } })
    .teacher_context?.teacher_id ?? "";

export const listTeacherLearners: ExpressFunction = async (req, res, next) => {
  try {
    const result = await listTeacherLearnersService(
      readTeacherId(req),
      req.query as unknown as ListTeacherLearnersQuery,
    );
    return res.status(result.statusCode).json({
      message: result.message,
      data: result.data,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/teacher/learners/:id — Todo 22.4.
 *
 * Returns the same base shape as the org-admin learner detail PLUS
 * the teacher-specific extras (recent sessions with turn-level
 * detail, vocab summary, stage 3 objectives with per-objective
 * progress, this teacher's review history, priority recommendation,
 * safeguarding alert count). See
 * `services/teacherLearnerDetail.service.ts` for the privacy
 * invariants (teacher-only review filter; safeguarding count only).
 */
export const getTeacherLearnerDetail: ExpressFunction = async (
  req,
  res,
  next,
) => {
  try {
    const { id } = req.params as { id: string };
    const result = await getTeacherLearnerDetailService(id, readTeacherId(req));
    return res.status(result.statusCode).json({
      message: result.message,
      data: result.data,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/teacher/learners/:id/review — Todo 22.5.
 *
 * Creates an append-only TeacherReview row, atomically increments
 * the learner's `glh_teacher_contact` + sets
 * `teacher_last_reviewed_at`, writes the audit row, and enqueues a
 * priority recalc on the priority-queue (Phase 23).
 *
 * Passes `req` to the service so the audit-log helper picks up
 * impersonation context if an Amber admin is impersonating the
 * teacher (Function 15).
 */
export const logTeacherReview: ExpressFunction = async (req, res, next) => {
  try {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as LogTeacherReviewBody;
    const result = await logTeacherReviewService({
      learner_id: id,
      teacher_id: readTeacherId(req),
      body,
      req,
    });
    return res.status(result.statusCode).json({
      message: result.message,
      data: result.data,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/teacher/learners/:id/pathway — Todo 22.6.
 *
 * Sets `User.pathway_override = { scenario_ids, set_by, set_at }`.
 * Override expires after 30 days; enforcement lives at session
 * start (Phase 9.6) and re-reads the timestamp written here.
 *
 * All-or-nothing scenario validation in the service — if any
 * scenario_id is missing or out-of-range for the learner's level,
 * the whole override is rejected with a 400 listing every problem.
 *
 * Also writes an append-only TeacherReview with
 * `review_type: "pathway_adjustment"`, `duration_mins: 0` (the
 * adjustment doesn't count as teacher-contact hours — audit-trail
 * purpose only).
 */
export const setPathwayOverride: ExpressFunction = async (req, res, next) => {
  try {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as SetPathwayOverrideBody;
    const result = await setPathwayOverrideService({
      learner_id: id,
      teacher_id: readTeacherId(req),
      body,
      req,
    });
    return res.status(result.statusCode).json({
      message: result.message,
      data: result.data,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/teacher/learners/:id/rarpa-signoff — Todo 22.7.
 *
 * Teacher's pedagogical sign-off on a learner's Stage 5 RARPA
 * review. Writes an append-only TeacherReview row with
 * `review_type: "rarpa_signoff"` and stamps the Stage5Review with
 * `teacher_signed_off_at` + `teacher_id`. Pre-conditions enforced
 * in the service: learner-self-assessment + ai-tutor-summary both
 * populated, and the review hasn't already been signed off
 * (single-shot).
 *
 * Org-admin compliance confirmation (Function 17) is a separate,
 * subsequent step — both halves must land before the review is
 * fully closed.
 */
export const signOffStage5Review: ExpressFunction = async (req, res, next) => {
  try {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as SignOffStage5ReviewBody;
    const result = await signOffStage5ReviewService({
      learner_id: id,
      teacher_id: readTeacherId(req),
      body,
      req,
    });
    return res.status(result.statusCode).json({
      message: result.message,
      data: result.data,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/teacher/learners/:id/message — Final Addendum §11 / Phase 24.
 *
 * Sends a 1-300 char message from the teacher to the learner.
 * When `translate_to_l1: true` and the learner's L1 isn't English,
 * Gemini translates the text (JSON-mode); the translated string
 * lands as `message_text` and the original English in
 * `original_text`. Translation failure is a hard 502 — the
 * teacher asked for L1 delivery, silently falling back to English
 * would defeat the purpose.
 *
 * Non-placeholder-email learners also get a content-free email
 * alert via the notifications queue ("you have a new tutor
 * message" + sign-in link — the body never leaves the in-product
 * inbox).
 */
export const sendTeacherMessage: ExpressFunction = async (req, res, next) => {
  try {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as SendTeacherMessageBody;
    const result = await sendTeacherMessageService({
      learner_id: id,
      teacher_id: readTeacherId(req),
      body,
      req,
    });
    return res.status(result.statusCode).json({
      message: result.message,
      data: result.data,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/teacher/messages/preview-translation — Final Addendum §11.
 *
 * Live-translation preview for the Send Message modal. Stateless:
 * no learner id, no persistence, no audit row, no notification.
 * Just the Gemini round-trip with the same prompt the send path
 * uses (so what the teacher sees is exactly what the learner
 * would receive on send).
 */
export const previewTeacherMessageTranslation: ExpressFunction = async (
  req,
  res,
  next,
) => {
  try {
    const body = (req.body ?? {}) as PreviewTranslationBody;
    const result = await previewTeacherMessageTranslationService({
      teacher_id: readTeacherId(req),
      body,
    });
    return res.status(result.statusCode).json({
      message: result.message,
      data: result.data,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/teacher/preferences — Final Addendum §11.
 *
 * Returns the calling teacher's preference flags so the dashboard
 * toggle can hydrate on mount. One field today
 * (`auto_re_engagement_enabled`); the response shape is an object
 * so future flags drop in without a breaking change.
 */
export const getTeacherPreferences: ExpressFunction = async (req, res, next) => {
  try {
    const teacherId = readTeacherId(req);
    const user = await User.findById(teacherId)
      .select("auto_re_engagement_enabled")
      .lean();
    return res.status(200).json({
      message: "Teacher preferences",
      data: {
        // The schema default is true; .lean() preserves missing
        // fields as undefined, so we coalesce here.
        auto_re_engagement_enabled:
          (user as { auto_re_engagement_enabled?: boolean } | null)
            ?.auto_re_engagement_enabled ?? true,
      },
    });
  } catch (err) {
    next(err);
  }
};

/**
 * PATCH /api/teacher/preferences/auto-re-engagement —
 * Final Addendum §11.
 *
 * Flip the auto-send re-engagement preference. Body:
 * `{ auto_re_engagement_enabled: boolean }`. The daily cron reads
 * this flag for every candidate teacher and skips those with
 * `false`.
 */
export const updateAutoReEngagement: ExpressFunction = async (
  req,
  res,
  next,
) => {
  try {
    const body = (req.body ?? {}) as UpdateAutoReEngagementBody;
    const result = await updateAutoReEngagementService({
      teacher_id: readTeacherId(req),
      body,
    });
    return res.status(result.statusCode).json({
      message: result.message,
      data: result.data,
    });
  } catch (err) {
    next(err);
  }
};
