import { Router } from "express";
import { isAuthenticated, isOrgAdmin } from "../middlewares/authMiddleWare";
import {
  listLearnersValidation,
  learnerIdParamValidation,
  updateLearnerValidation,
} from "../validations/esolLearner.validation";
import {
  listLearners,
  getLearner,
  updateLearner,
  getLearnerVocabLedger,
  getLearnerSessions,
} from "../controllers/esolLearner.controller";

const router = Router();

router.use(isAuthenticated, isOrgAdmin);

// List learners in org
router.get("/", listLearnersValidation(), listLearners);

// Get / update single learner
router
  .route("/:learnerId")
  .get(learnerIdParamValidation(), getLearner)
  .patch(updateLearnerValidation(), updateLearner);

// Phase 13 dashboard data — vocab ledger + session list for one learner.
// Service does the org ACL with admin bypass; the file-level `isOrgAdmin`
// gate above keeps students/tutors out.
router.get(
  "/:learnerId/vocab-ledger",
  learnerIdParamValidation(),
  getLearnerVocabLedger
);
router.get(
  "/:learnerId/sessions",
  learnerIdParamValidation(),
  getLearnerSessions
);

export default router;
