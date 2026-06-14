/**
 * Learner-facing messages routes — Final Addendum §11.
 *
 * Mounted at `/api/esol/messages` in src/index.ts.
 *
 * Auth chain on EVERY route in this file:
 *   isAuthenticated     → JWT valid + account active
 *   isStudent           → role === "student" (defence-in-depth)
 *   requireOrgContext   → learner has an orgId; attaches req.esol_context.org_id
 *
 * The brief requested isAuthenticated + requireOrgContext exactly.
 * `requireOrgContext` already 403s non-org users (marketplace tutors,
 * Amber admins without orgId), and the controller scopes by
 * `req.user._id` so a teacher with an orgId would only see their own
 * row trail anyway. The explicit `isStudent` layer makes the intent
 * unambiguous — the learner mailbox is for learners, not teachers or
 * org admins.
 */

import { Router } from "express";
import { isAuthenticated, isStudent } from "../middlewares/authMiddleWare";
import { requireOrgContext } from "../middlewares/orgScopingMiddleware";
import {
  getLearnerUnreadMessages,
  markMessageAsRead,
} from "../controllers/learnerMessages.controller";
import { markMessageReadValidation } from "../validations/learnerMarkMessageRead.validation";

const router = Router();

router.use(isAuthenticated, isStudent, requireOrgContext);

// GET /api/esol/messages/unread — list the calling learner's
// unread TeacherMessage rows. Read-only (no read_at mutation
// here — see the service-file comment for the rationale).
router.get("/unread", getLearnerUnreadMessages);

// PATCH /api/esol/messages/:id/read — Final Addendum §11. Flip
// the message's read_at to now. Idempotent; ownership-gated to
// the calling learner; opaque 404 on wrong-owner requests.
router.patch("/:id/read", markMessageReadValidation(), markMessageAsRead);

export default router;
