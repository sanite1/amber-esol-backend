/**
 * Amber-admin teacher utilisation routes — Final Addendum §4.
 *
 * Mounted at /api/admin/teacher-utilisation.
 *
 * Auth: Amber admin only.
 *   isAuthenticated → JWT valid + account active
 *   isAdmin         → role === "admin"
 *
 * Endpoints:
 *   GET  /                          per-teacher rollup
 *                                   ?org_id=<id> optional filter
 *   GET  /:teacherId/history        TeacherReview drilldown
 *                                   ?limit=<n>   default 100, capped 500
 */

import { Router } from "express";
import { isAuthenticated, isAdmin } from "../middlewares/authMiddleWare";
import {
  getTeacherUtilisation,
  getTeacherHistory,
} from "../controllers/adminTeacherUtilisation.controller";

const router = Router();

router.use(isAuthenticated, isAdmin);

router.get("/", getTeacherUtilisation);
router.get("/:teacherId/history", getTeacherHistory);

export default router;
