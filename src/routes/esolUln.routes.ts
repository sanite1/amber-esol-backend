import { Router } from "express";
import { isAuthenticated } from "../middlewares/authMiddleWare";
import { requireEsolLearner } from "../middlewares/orgScopingMiddleware";
import { declareUlnValidation } from "../validations/esolUln.validation";
import { declareUln } from "../controllers/esolUln.controller";

/**
 * POST /api/esol/uln — brief Function 2 To-Do 4.
 *
 * Middleware chain:
 *   1. isAuthenticated — populates req.user, re-hydrates from DB,
 *      catches the org-drift edge case
 *   2. requireEsolLearner — role must be "student" AND orgId set.
 *      Blocks marketplace students and admin roles from writing to a
 *      learner's ULN field
 *
 * The brief specifies just isAuthenticated; we add requireEsolLearner
 * as defence-in-depth because the endpoint mutates uln/ulnStatus —
 * a non-ESOL caller should never touch those fields.
 */
const router = Router();

router.post(
  "/",
  isAuthenticated,
  requireEsolLearner,
  declareUlnValidation(),
  declareUln
);

export default router;
