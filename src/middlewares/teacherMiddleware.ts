/**
 * Teacher-role middleware — Final Addendum §9.
 *
 * Two middlewares, intended to be chained AFTER `isAuthenticated`:
 *
 *   router.use(isAuthenticated, requireTeacherRole, requireTeacherContext);
 *
 * `requireTeacherRole` enforces that the caller is a fully-cleared
 * ESOL teacher — approved by Amber admin AND DBS-cleared. Either gate
 * missing → 403, with a message specific to the missing gate so
 * support can route the user to the right next action.
 *
 * `requireTeacherContext` attaches `req.teacher_context` so
 * downstream services receive `teacher_id` as an explicit param,
 * matching the same pattern `requireOrgContext` uses for `org_id`.
 * Services NEVER read `req.user.id` for teacher scoping — they
 * read the context. This makes cross-teacher leakage impossible
 * to ship accidentally; a service signature like
 * `listMyLearners(teacherId, query)` forces the caller to wire the
 * context through at code review.
 *
 * Why split into two middlewares (vs one combined)
 * ================================================
 *
 * The role gate and the context attachment are independently
 * useful. A future read-only "teacher-self-profile" endpoint may
 * need the context attached but not the full DBS-cleared check
 * (e.g. a not-yet-approved teacher viewing their own application
 * status). Splitting keeps each gate composable.
 *
 * Defence-in-depth notes
 * ======================
 *
 *   1. `isAuthenticated` re-hydrates `esol_teacher_approved` and
 *      `dbs_check_status` from the database on every request — we
 *      NEVER trust the JWT-issued copy of either field. A teacher
 *      whose DBS expires between JWT issue and expiry stops
 *      passing this gate immediately, no re-login required.
 *
 *   2. The `dbsCheckStatus` enum on the User model currently
 *      contains both `"clear"` and `"cleared"` literals (a
 *      historical migration artefact). The Final Addendum §9
 *      brief specifies `"cleared"` — we check the brief's literal
 *      value. A user still carrying `"clear"` is treated as
 *      not-passing; the data-migration ticket
 *      `docs/data-migrations/dbs-check-status.md` (to be authored)
 *      bulk-rewrites legacy values.
 */

import { Types } from "mongoose";
import ApiError from "../errors/apiError";
import { ExpressFunction, ITeacherContext } from "../interfaces/helper.interface";

// ─────────────────────────────────────────────────────────────────────
// Role gate — requireTeacherRole
// ─────────────────────────────────────────────────────────────────────

/**
 * Required role for any teacher-scoped route. Caller must:
 *
 *   - have `role === "tutor"` (the User-model literal for a teacher
 *     account; "teacher" doesn't exist as a User role today)
 *   - have `esol_teacher_approved === true` (Amber admin reviewed
 *     and approved the ESOL teaching application)
 *   - have `dbs_check_status === "cleared"` (DBS check returned
 *     clear and was recorded)
 *
 * Returns 403 with a precise message naming the missing gate so
 * the calling UI / support flow can route the teacher to the
 * right next action. We DO NOT return generic "forbidden" — that
 * would force every support conversation to dig through logs to
 * find out which gate failed.
 *
 * NEVER mount this WITHOUT `isAuthenticated` upstream — the
 * snake_case fields it reads are populated by the auth middleware's
 * DB re-hydration. A teacher route that mounts this without
 * `isAuthenticated` first will incorrectly 403 every request
 * because `req.user` is undefined.
 */
export const requireTeacherRole: ExpressFunction = (req, _res, next) => {
  try {
    const user = req.user;
    if (!user) {
      // Defence-in-depth — should never trigger when chained
      // after `isAuthenticated`, but a clear error if someone
      // forgets to mount the auth middleware upstream.
      return next(
        new ApiError(
          401,
          "Authentication required (mount isAuthenticated before requireTeacherRole).",
        ),
      );
    }
    if (user.role !== "tutor") {
      return next(
        new ApiError(403, "Teacher role required for this resource."),
      );
    }
    if (user.esol_teacher_approved !== true) {
      return next(
        new ApiError(
          403,
          "Your ESOL teaching application has not yet been approved by Amber. " +
            "An admin must review your application before you can access teacher routes.",
        ),
      );
    }
    if (user.dbs_check_status !== "cleared") {
      return next(
        new ApiError(
          403,
          "Your DBS check is not on file as cleared. Upload your current DBS " +
            "certificate via your teacher profile and contact support if the " +
            "status hasn't updated within 5 working days.",
        ),
      );
    }
    next();
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────────────────────────────
// Context attachment — requireTeacherContext
// ─────────────────────────────────────────────────────────────────────

/**
 * Attach `req.teacher_context = { teacher_id: req.user.id }` so
 * downstream services can pull a scoped teacher id from the
 * request without reading `req.user` directly. Mirrors the pattern
 * `requireOrgContext` establishes for `org_id`.
 *
 * Returns 403 when `req.user` is missing or doesn't carry a valid
 * ObjectId — a defensive check, since `isAuthenticated` upstream
 * already validates the token. The check exists so that mounting
 * this middleware standalone (e.g. in a misconfigured router)
 * fails closed rather than attaching `teacher_id: "undefined"`
 * to the context.
 *
 * Does NOT itself check role / approval / DBS — pair with
 * `requireTeacherRole` for those gates. The separation lets a
 * future not-yet-approved-teacher-self-profile route attach the
 * context without forcing the full clearance gate.
 */
export const requireTeacherContext: ExpressFunction = (req, _res, next) => {
  try {
    const user = req.user;
    if (!user) {
      return next(
        new ApiError(
          401,
          "Authentication required (mount isAuthenticated before requireTeacherContext).",
        ),
      );
    }
    const idStr = user.id?.toString();
    if (!idStr || !Types.ObjectId.isValid(idStr)) {
      return next(
        new ApiError(
          403,
          "Authenticated user has no valid id — cannot establish teacher context.",
        ),
      );
    }

    const context: ITeacherContext = { teacher_id: idStr };
    (req as typeof req & { teacher_context: ITeacherContext }).teacher_context =
      context;
    next();
  } catch (error) {
    next(error);
  }
};
