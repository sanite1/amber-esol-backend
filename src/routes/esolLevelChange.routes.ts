import { Router } from "express";
import {
  isAuthenticated,
  isOrgAdmin,
} from "../middlewares/authMiddleWare";
import {
  createLevelChangeValidation,
  listLevelChangesValidation,
} from "../validations/esolLevelChange.validation";
import {
  createLevelChange,
  listLevelChanges,
} from "../controllers/esolLevelChange.controller";

const router = Router();

router.use(isAuthenticated, isOrgAdmin);

router.post("/", createLevelChangeValidation(), createLevelChange);
router.get("/", listLevelChangesValidation(), listLevelChanges);

export default router;
