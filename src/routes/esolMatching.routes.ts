import { Router } from "express";
import { isAuthenticated } from "../middlewares/authMiddleWare";
import { requireOrgContext } from "../middlewares/orgScopingMiddleware";
import { getEsolTeacherMatches } from "../controllers/esolMatching.controller";

/**
 * Mounted at /api/esol/teacher-matches in src/index.ts.
 *
 * Single-route router so the brief's exact URL `GET /api/esol/teacher-matches`
 * lands cleanly without trailing path segments.
 *
 * Middleware order:
 *   1. isAuthenticated — populates req.user with the learner's JWT claims
 *   2. requireOrgContext — refuses non-org-scoped users (marketplace
 *      students, admin without an org context). Also attaches
 *      req.esol_context.org_id which the controller could use for further
 *      scoping if needed.
 */
const router = Router();

router.get("/", isAuthenticated, requireOrgContext, getEsolTeacherMatches);

export default router;
