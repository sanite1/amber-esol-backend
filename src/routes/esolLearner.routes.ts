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

export default router;
