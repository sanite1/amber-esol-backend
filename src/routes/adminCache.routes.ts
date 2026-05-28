import { Router } from "express";
import { isAuthenticated, isAdmin } from "../middlewares/authMiddleWare";
import {
  reloadPostcodeDataset,
  reloadFalaWhitelist,
} from "../controllers/adminCache.controller";

const router = Router();

router.use(isAuthenticated, isAdmin);

router.post("/postcode/reload", reloadPostcodeDataset);
router.post("/fala/reload", reloadFalaWhitelist);

export default router;
