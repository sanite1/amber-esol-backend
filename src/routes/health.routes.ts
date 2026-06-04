import { Router, Request, Response } from "express";
import { isAuthenticated, isAdmin } from "../middlewares/authMiddleWare";
import {
  checkGeminiHealth,
  checkRedisHealth,
} from "../controllers/health.controller";

const router = Router();

/**
 * GET /api/health — public ping (M0.5).
 *
 * Returns a fast, dependency-free JSON heartbeat the frontend's
 * /__diag page can call to confirm:
 *   • the backend is reachable from the current subdomain (CORS
 *     allow-list is correct)
 *   • the deployed build is the one expected
 *   • demo-mode + env are what we think they are
 *
 * Deliberately no DB / Redis probe here — those can flap and we
 * don't want uptime monitors to alarm on transient blips. The
 * deeper probes live at /api/health/gemini and /api/health/redis,
 * both admin-only.
 */
router.get("/", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    env: process.env.NODE_ENV ?? "unknown",
    demoMode: process.env.DEMO_MODE === "true",
    // Vercel injects VERCEL_GIT_COMMIT_SHA on every build; local dev
    // falls back to "dev".
    build:
      process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ??
      process.env.GIT_COMMIT_SHA?.slice(0, 7) ??
      "dev",
    timestamp: new Date().toISOString(),
  });
});

// GET /api/health/gemini — admin-only Vertex AI reachability probe
router.get("/gemini", isAuthenticated, isAdmin, checkGeminiHealth);

// GET /api/health/redis — admin-only Redis reachability probe
router.get("/redis", isAuthenticated, isAdmin, checkRedisHealth);

export default router;
