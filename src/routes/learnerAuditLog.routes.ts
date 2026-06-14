/**
 * Learner-self audit log route — Final Addendum §6 (BE-A).
 *
 * Mounted at /api/learner/me/audit-log.
 *
 * Auth chain:
 *   isAuthenticated  → JWT valid + account active
 *   isStudent        → role === "student" (belt-and-braces)
 *
 * The service ALREADY hardcodes `learner_id = req.user._id`, so a
 * non-learner reaching this route would just see an empty list —
 * no cross-learner leakage possible at the data layer. The explicit
 * `isStudent` gate makes the intent unambiguous and keeps a future
 * controller change from silently widening access. The isStudent
 * check reads an already-decoded role claim from the JWT (no extra
 * DB read).
 */

import { Router } from "express";
import { isAuthenticated, isStudent } from "../middlewares/authMiddleWare";
import { learnerAuditLogValidation } from "../validations/learnerAuditLog.validation";
import { listLearnerAuditLog } from "../controllers/learnerAuditLog.controller";

const router = Router();

router.use(isAuthenticated, isStudent);

router.get("/me/audit-log", learnerAuditLogValidation(), listLearnerAuditLog);

export default router;
