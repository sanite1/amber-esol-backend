import { Router } from "express";
import { isAuthenticated, isStudent } from "../middlewares/authMiddleWare";
import {
  listVocabValidation,
  updateMasteryValidation,
} from "../validations/esolVocab.validation";
import { listVocab, updateMastery } from "../controllers/esolVocab.controller";

/**
 * Auth chain on every route in this file:
 *   isAuthenticated → JWT valid + account active
 *   isStudent       → role === "student"
 *
 * Defence-in-depth: the controller already scopes by `req.user._id`
 * so a non-student authenticated caller would see an empty list,
 * but the route-level role gate makes the intent unambiguous and
 * keeps a future controller change from silently widening access.
 */

const router = Router();

router.use(isAuthenticated, isStudent);

router.get("/", listVocabValidation(), listVocab);
router.patch("/:vocabId/mastery", updateMasteryValidation(), updateMastery);

export default router;
