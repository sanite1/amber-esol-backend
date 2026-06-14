/**
 * Teacher route group — Final Addendum §9.
 *
 * Mounted at `/api/teacher` in src/index.ts.
 *
 * Auth chain on EVERY route in this file:
 *   isAuthenticated      → JWT valid + account active
 *   requireTeacherRole   → role === "tutor" AND esol_teacher_approved === true
 *                          AND dbs_check_status === "cleared"
 *   requireTeacherContext → attaches req.teacher_context.teacher_id
 *
 * Status (as of this commit)
 * ==========================
 *
 * The auth chain is fully wired and tested via the Final Addendum §9
 * teacher middleware (see `middlewares/teacherMiddleware.ts`). The
 * per-route controllers are stubbed pending their dedicated todos:
 *
 *   GET    /learners                       Todo 22.3
 *   GET    /learners/:id                   Todo 22.4
 *   POST   /learners/:id/review            Todo 22.5
 *   POST   /learners/:id/pathway           Todo 22.6
 *   POST   /learners/:id/rarpa-signoff     Todo 22.7
 *   GET    /learners/:id/priority-actions  Phase 23 (teacher prep scoring)
 *   POST   /learners/:id/message           Phase 24 (teacher messaging)
 *
 * Each stubbed route 501s with a structured payload pointing at the
 * todo / phase that ships the real controller. A 501 (not 404) is the
 * deliberate signal: "the route exists, the auth chain is honoured,
 * the controller body is forthcoming". When the real controller
 * lands, only the import line changes in this file — every other
 * caller already routes correctly.
 *
 * Why stub rather than wait
 * =========================
 *
 * Two reasons:
 *
 *   1. The auth chain is the cross-cutting concern. Mounting it once
 *      here means the per-todo work in 22.3-22.7 doesn't have to
 *      re-derive "what middleware do teacher routes use?" — they
 *      just write the controller and slot it in.
 *   2. Frontend work (Phase 24 messaging UI, Phase 23 teacher
 *      dashboards) can develop against these endpoints today, get a
 *      deliberate 501 with a clear pointer, and stub their own data
 *      layer until the backend controllers land. Better than a 404
 *      that leaves the frontend uncertain whether the URL is even
 *      planned.
 */

import { Router, Request, Response } from "express";
import { isAuthenticated } from "../middlewares/authMiddleWare";
import {
  requireTeacherRole,
  requireTeacherContext,
} from "../middlewares/teacherMiddleware";
import {
  listTeacherLearners,
  getTeacherLearnerDetail,
  logTeacherReview,
  setPathwayOverride,
  signOffStage5Review,
  sendTeacherMessage,
  previewTeacherMessageTranslation,
  getTeacherPreferences,
  updateAutoReEngagement,
} from "../controllers/teacherLearners.controller";
import { logTeacherReviewValidation } from "../validations/teacherReview.validation";
import { setPathwayOverrideValidation } from "../validations/teacherPathway.validation";
import { signOffStage5ReviewValidation } from "../validations/teacherRarpaSignoff.validation";
import { sendTeacherMessageValidation } from "../validations/teacherMessage.validation";
import { previewTranslationValidation } from "../validations/teacherMessagePreview.validation";
import { updateAutoReEngagementValidation } from "../validations/teacherPreferences.validation";
import {
  getTeachingProfile,
  updateTeachingProfile,
} from "../controllers/teacherTeachingProfile.controller";
import { updateTeachingProfileValidation } from "../validations/teacherTeachingProfile.validation";
// Phase 1 / Final Addendum §6 (BE-C) — teacher-scoped audit log.
import { teacherAuditLogValidation } from "../validations/teacherAuditLog.validation";
import { listTeacherAuditLog } from "../controllers/teacherAuditLog.controller";
import logger from "../config/logger";

const router = Router();

// Auth chain applied once to every route in this file. The teacher
// middleware also runs the DB re-hydration that populates the
// snake_case `esol_teacher_approved` + `dbs_check_status` fields the
// gate reads — never trust the JWT-issued copies for auth decisions.
router.use(isAuthenticated, requireTeacherRole, requireTeacherContext);

// ─────────────────────────────────────────────────────────────────────
// Placeholder factory — used for every route until its dedicated todo
// builds the real controller.
//
// Returns 501 (not 404) so a caller can tell "the route is planned"
// vs "the URL is wrong". The structured body includes the todo
// reference so frontend logs surface what's pending; ops can grep
// for `todo_reference` to find unbuilt routes hit prematurely.
// ─────────────────────────────────────────────────────────────────────

const notYetImplemented = (todoRef: string, description: string) => {
  return (req: Request, res: Response) => {
    logger.info(
      {
        route: req.path,
        method: req.method,
        todo_reference: todoRef,
        teacher_id: (
          req as Request & { teacher_context?: { teacher_id: string } }
        ).teacher_context?.teacher_id,
      },
      "teacher route hit before its controller landed",
    );
    return res.status(501).json({
      message: `Not yet implemented — ${description}`,
      todo_reference: todoRef,
    });
  };
};

// ─────────────────────────────────────────────────────────────────────
// Routes — stubs await their per-todo controllers
// ─────────────────────────────────────────────────────────────────────

// Todo 22.3 — list the learners assigned to this teacher.
// Filters: ?priority=p1|p2|p3|p4, ?org_id=…, ?search=… + pagination.
// Sort: teacher_priority_level asc (p1 first), then
// teacher_priority_updated_at desc within tier.
router.get("/learners", listTeacherLearners);

// Todo 22.4 — single-learner detail view for the teacher.
// Same base shape as the org-admin learner detail PLUS recent
// sessions with turn-level detail, vocab summary, Stage 3
// objectives annotated with per-objective progress, this teacher's
// review history, current priority recommendation, and a
// safeguarding alert count (no detail — DSL-only).
router.get("/learners/:id", getTeacherLearnerDetail);

// Phase 1 / Final Addendum §6 (BE-C) — teacher-scoped audit log for
// one of their assigned learners. The service enforces the same
// assignment gate as /learners/:id (404 then 403) before returning
// any rows.
router.get(
  "/learners/:id/audit-log",
  teacherAuditLogValidation(),
  listTeacherAuditLog,
);

// Todo 22.5 — log a teacher review. Body:
//   { review_type, duration_mins, notes?, ai_recommendation_acted_on }
// Creates an append-only TeacherReview, atomically updates the
// learner's GLH + teacher_last_reviewed_at, audits, and enqueues a
// priority recalc on the priority-queue (Phase 23).
router.post(
  "/learners/:id/review",
  logTeacherReviewValidation(),
  logTeacherReview,
);

// Todo 22.6 — set a pathway override. Body: { scenario_ids: string[] }.
// Writes `User.pathway_override = { scenario_ids, set_by, set_at }`
// (30-day TTL enforced at session start in Phase 9.6) PLUS an
// append-only TeacherReview row with review_type: "pathway_adjustment"
// and duration_mins: 0 as the audit-trail companion.
// All-or-nothing scenario validation — any bad id rejects the whole
// override with a 400 listing every problem.
router.post(
  "/learners/:id/pathway",
  setPathwayOverrideValidation(),
  setPathwayOverride,
);

// Todo 22.7 — teacher signs off a learner's Stage 5 RARPA review.
// Writes an append-only TeacherReview with review_type:
// "rarpa_signoff" + duration_mins: 0 (sign-off doesn't accrue
// contact hours), then stamps the Stage5Review with
// `teacher_signed_off_at` + `teacher_id`. Service-layer gates:
//   - assignment (404 vs 403 disambiguated)
//   - stage5_review_id belongs to this learner (opaque 404)
//   - learner_self_assessment + ai_tutor_summary both populated (409)
//   - single-shot — refuses if already signed off (409)
// Audit row: `rarpa_stage5_teacher_signed_off`.
router.post(
  "/learners/:id/rarpa-signoff",
  signOffStage5ReviewValidation(),
  signOffStage5Review,
);

// Phase 23 — teacher prep scoring. Returns the ranked list of actions
// the teacher should take on this learner before their next contact
// session. Backed by the `priority-queue` BullMQ worker (currently
// stubbed in `services/queueProcessors/index.ts` — Phase 23 ships
// the scoring algorithm).
router.get(
  "/learners/:id/priority-actions",
  notYetImplemented(
    "Phase 23",
    "GET /api/teacher/learners/:id/priority-actions — teacher prep scoring",
  ),
);

// Final Addendum §11 / Phase 24 — teacher messaging.
// Sends a 1-300 char message from the teacher to the learner.
// Optional Gemini translation to the learner's L1 (hard-fails 502
// on translation outage rather than silently sending English).
// Creates a TeacherMessage row, audits, enqueues a content-free
// "you have a message" email if the learner has a real (non-
// placeholder) email on file.
router.post(
  "/learners/:id/message",
  sendTeacherMessageValidation(),
  sendTeacherMessage,
);

// Final Addendum §11 — translation preview for the Send Message
// modal. Stateless (no learner id, no persistence) — the only
// side effect is the Gemini call. Same auth chain as every other
// /teacher/* route via router.use(...) above.
router.post(
  "/messages/preview-translation",
  previewTranslationValidation(),
  previewTeacherMessageTranslation,
);

// Final Addendum §11 — teacher self-service preferences.
//
//   GET   /api/teacher/preferences                      hydrate the toggle
//   PATCH /api/teacher/preferences/auto-re-engagement   flip the toggle
//
// One-field today (`auto_re_engagement_enabled`). The GET returns
// an object so adding future flags is non-breaking; PATCH is
// per-field so partial updates can't accidentally clobber an
// unrelated preference.
router.get("/preferences", getTeacherPreferences);
router.patch(
  "/preferences/auto-re-engagement",
  updateAutoReEngagementValidation(),
  updateAutoReEngagement,
);

// Teaching profile — the matching foundation (teacherMatching
// .service.ts). Self-served: the teacher declares levels taught,
// languages spoken and specialisms; org admins see the profile as
// chips on the Teacher Assignment page and matching uses it to rank
// suggestions.
//
//   GET   /api/teacher/teaching-profile
//   PATCH /api/teacher/teaching-profile
router.get("/teaching-profile", getTeachingProfile);
router.patch(
  "/teaching-profile",
  updateTeachingProfileValidation(),
  updateTeachingProfile,
);

export default router;
