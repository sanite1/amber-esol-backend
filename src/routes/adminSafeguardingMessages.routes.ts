/**
 * Amber-admin safeguarding response-text CMS — Final Addendum §2.
 *
 * Mounted at /api/admin/safeguarding-messages. Amber admin only —
 * these texts are what a learner in crisis sees, so editing them is
 * a platform-level responsibility, not an org one.
 */

import { Router } from "express";
import { isAuthenticated, isAdmin } from "../middlewares/authMiddleWare";
import {
  listSafeguardingMessages,
  updateSafeguardingMessage,
} from "../controllers/adminSafeguardingMessages.controller";

const router = Router();

router.use(isAuthenticated, isAdmin);

router.get("/", listSafeguardingMessages);
router.put("/", updateSafeguardingMessage);

export default router;
