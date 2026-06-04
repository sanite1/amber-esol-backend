/**
 * Admin queues routes — Final Addendum §1.
 *
 * Mounted at /api/admin/queues. (The Bull Board UI itself lives at
 * the unprefixed /admin/queues — see src/index.ts for that mount.)
 *
 * Auth chain — Amber admin only. No requireOrgContext; queues are
 * platform-wide.
 *   isAuthenticated → JWT valid + account active
 *   isAdmin         → role === "admin"
 *
 * Endpoints:
 *   GET  /summary   per-queue job counts (waiting / active / completed
 *                   / failed / delayed) plus totals. Powers the queue
 *                   summary header on the dashboard's Queues page.
 *   GET  /link      signed Bull Board URL with the ?token= query
 *                   param attached. The dashboard opens this URL in
 *                   a new tab — see middlewares/bullBoardToken.ts for
 *                   why the token is in the URL rather than a header.
 */

import { Router } from "express";
import { isAuthenticated, isAdmin } from "../middlewares/authMiddleWare";
import {
  getQueueSummary,
  getBullBoardLink,
} from "../controllers/adminQueues.controller";

const router = Router();

router.use(isAuthenticated, isAdmin);

router.get("/summary", getQueueSummary);
router.get("/link", getBullBoardLink);

export default router;
