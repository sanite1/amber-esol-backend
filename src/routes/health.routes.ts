import { Router } from "express";
import { isAuthenticated, isAdmin } from "../middlewares/authMiddleWare";
import {
  checkGeminiHealth,
  checkRedisHealth,
} from "../controllers/health.controller";

const router = Router();

// GET /api/health/gemini — admin-only Vertex AI reachability probe
router.get("/gemini", isAuthenticated, isAdmin, checkGeminiHealth);

// GET /api/health/redis — admin-only Redis reachability probe
router.get("/redis", isAuthenticated, isAdmin, checkRedisHealth);

export default router;
