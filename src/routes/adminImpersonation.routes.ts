/**
 * Amber-admin impersonation routes — brief Function 15.
 *
 * Mounted at /api/admin/impersonate.
 *
 * Auth chain — Amber admin only. No requireOrgContext: impersonation
 * spans orgs by design.
 *   isAuthenticated → JWT valid + account active
 *   isAdmin         → role === "admin" (Amber super-admin)
 *
 * Endpoints:
 *   POST  /:user_id   Mint an impersonation JWT for the target user.
 *                     Returns { access_token, expires_in, target,
 *                     impersonated_by }.
 *
 * Security notes:
 *   - Impersonation tokens carry a shorter TTL (1h) than the default
 *     5h session. See adminImpersonation.service.ts file header.
 *   - The audit row for the opening event records the admin as the
 *     actor; subsequent rows written via the impersonation token
 *     carry the target as actor_id and the admin as impersonated_by.
 */

import { Router } from "express";
import { isAuthenticated, isAdmin } from "../middlewares/authMiddleWare";
import { startImpersonation } from "../controllers/adminImpersonation.controller";

const router = Router();

router.use(isAuthenticated, isAdmin);

router.post("/:user_id", startImpersonation);

export default router;
