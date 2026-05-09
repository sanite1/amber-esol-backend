import { Router } from "express";
import { isAuthenticated } from "../middlewares/authMiddleWare";
import {
  listVocabValidation,
  updateMasteryValidation,
} from "../validations/esolVocab.validation";
import { listVocab, updateMastery } from "../controllers/esolVocab.controller";

const router = Router();

router.use(isAuthenticated);

router.get("/", listVocabValidation(), listVocab);
router.patch(
  "/:vocabId/mastery",
  updateMasteryValidation(),
  updateMastery
);

export default router;
