import { Router } from "express";
import { isAuthenticated } from "../middlewares/authMiddleWare";
import { getJobStatus } from "../controllers/jobs.controller";

const router = Router();

// GET /api/jobs/:queue/:jobId/status — any authenticated user can poll a job
// status. Authorization to view the underlying work is the responsibility of
// the route that issued the 202; once the client has a jobId they are
// implicitly authorised to see its progress.
router.get("/:queue/:jobId/status", isAuthenticated, getJobStatus);

export default router;
