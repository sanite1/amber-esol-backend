/**
 * Admin failed-jobs review routes — Final Addendum §1.
 *
 * Mounted at /api/admin/failed-jobs.
 *
 * Auth: Amber admin only.
 *   isAuthenticated → JWT valid + account active
 *   isAdmin         → role === "admin"
 *
 * Endpoints:
 *   GET    /              list paginated failed jobs
 *                         ?queue=<name> filter to one queue
 *                         ?from=<iso> ?to=<iso> date range (incl)
 *                         ?page=<n>  ?limit=<n>  (default 25, max 200)
 *                         ?include_dismissed=true to show dismissed
 *   GET    /count         unresolved (non-dismissed) failure count
 *                         — powers the sidebar badge
 *   POST   /:id/retry     re-enqueue the original job onto its queue
 *   DELETE /:id           soft-delete (set dismissed: true)
 */

import { Router } from "express";
import { isAuthenticated, isAdmin } from "../middlewares/authMiddleWare";
import {
  listFailedJobs,
  countFailedJobs,
  retryFailedJob,
  dismissFailedJob,
} from "../controllers/adminFailedJobs.controller";

const router = Router();

router.use(isAuthenticated, isAdmin);

router.get("/", listFailedJobs);
router.get("/count", countFailedJobs);
router.post("/:id/retry", retryFailedJob);
router.delete("/:id", dismissFailedJob);

export default router;
