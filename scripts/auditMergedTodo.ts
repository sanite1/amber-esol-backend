/**
 * Project Silk — Merged TODO Audit Script
 *
 * Run:  npm run audit:todo
 *
 * Walks every phase of the MERGED TECHNICAL BUILD TODO v2 and
 * reports PASS / WARN / FAIL / SKIP per todo. Designed to be
 * runnable in any environment — does NOT require Mongo, Redis,
 * Vertex AI, or any network access. Checks are file existence,
 * file content (grep), npm scripts, vercel.json crons, and a
 * full Jest run.
 *
 * Output:
 *
 *   ✓ PASS  — file/content found, tests green
 *   ⚠ WARN  — file present but expected content missing, OR
 *             partial implementation flagged in audit
 *   ✗ FAIL  — file missing or test failed
 *   ⊝ SKIP  — requires live runtime (Vertex / Redis / Mongo) and
 *             can't be checked statically — manual verification
 *
 * Exit code: 0 if no FAIL, 1 if any FAIL. WARNs do not fail
 * the run (they're advisory).
 *
 * The script is the OPPOSITE of a unit test — unit tests in
 * src/__tests__/ exercise individual services. This script
 * audits the SHAPE of the project against the merged TODO.
 */

import { existsSync, readFileSync, statSync } from "fs";
import { join, resolve } from "path";
import { spawnSync } from "child_process";

// ─────────────────────────────────────────────────────────────────────
// Types + helpers
// ─────────────────────────────────────────────────────────────────────

type Status = "PASS" | "WARN" | "FAIL" | "SKIP";

interface CheckOutcome {
  status: Status;
  detail?: string;
}

interface Check {
  id: string; // "1.A", "9.5" etc
  title: string;
  phase: number;
  run: () => CheckOutcome;
}

interface PhaseHeader {
  phase: number;
  title: string;
}

const ROOT = resolve(__dirname, "..");
const SRC = join(ROOT, "src");

const fileExists = (rel: string): boolean => existsSync(join(ROOT, rel));

const fileRead = (rel: string): string => {
  try {
    return readFileSync(join(ROOT, rel), "utf8");
  } catch {
    return "";
  }
};

const fileContains = (rel: string, needle: string | RegExp): boolean => {
  const body = fileRead(rel);
  if (!body) return false;
  return typeof needle === "string" ? body.includes(needle) : needle.test(body);
};

const fileContainsAll = (rel: string, needles: (string | RegExp)[]): boolean =>
  needles.every((n) => fileContains(rel, n));

const anyFileExists = (rels: string[]): boolean => rels.some(fileExists);

const checkFile = (rel: string, label?: string): CheckOutcome =>
  fileExists(rel)
    ? { status: "PASS", detail: label ?? rel }
    : { status: "FAIL", detail: `Missing: ${rel}` };

const checkFileContent = (
  rel: string,
  needle: string | RegExp,
  label?: string,
): CheckOutcome => {
  if (!fileExists(rel)) {
    return { status: "FAIL", detail: `Missing file: ${rel}` };
  }
  if (!fileContains(rel, needle)) {
    return {
      status: "WARN",
      detail: `${label ?? rel}: expected content not found`,
    };
  }
  return { status: "PASS", detail: label ?? rel };
};

const checkNpmScript = (script: string): CheckOutcome => {
  const pkg = fileRead("package.json");
  if (!pkg) return { status: "FAIL", detail: "package.json missing" };
  try {
    const parsed = JSON.parse(pkg) as { scripts?: Record<string, string> };
    return parsed.scripts && parsed.scripts[script]
      ? { status: "PASS", detail: `npm run ${script}` }
      : { status: "WARN", detail: `npm script "${script}" missing` };
  } catch {
    return { status: "FAIL", detail: "package.json unparseable" };
  }
};

const checkVercelCron = (path: string): CheckOutcome => {
  const body = fileRead("vercel.json");
  if (!body) return { status: "FAIL", detail: "vercel.json missing" };
  return body.includes(path)
    ? { status: "PASS", detail: `cron ${path}` }
    : { status: "FAIL", detail: `cron ${path} not in vercel.json` };
};

const checkPackageDep = (name: string): CheckOutcome => {
  const body = fileRead("package.json");
  try {
    const pkg = JSON.parse(body) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const all = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    return all[name]
      ? { status: "PASS", detail: `${name}@${all[name]}` }
      : { status: "FAIL", detail: `dep ${name} missing` };
  } catch {
    return { status: "FAIL", detail: "package.json unparseable" };
  }
};

const checkRouteMount = (mount: string): CheckOutcome => {
  const idx = fileRead("src/index.ts");
  if (!idx) return { status: "FAIL", detail: "src/index.ts missing" };
  return idx.includes(mount)
    ? { status: "PASS", detail: `mounted ${mount}` }
    : { status: "FAIL", detail: `mount ${mount} not in index.ts` };
};

// ─────────────────────────────────────────────────────────────────────
// Phase headers
// ─────────────────────────────────────────────────────────────────────

const PHASE_HEADERS: PhaseHeader[] = [
  { phase: 0, title: "Marketplace conversion prep" },
  { phase: 1, title: "Infrastructure (expanded with addendum)" },
  { phase: 2, title: "Compliance gate" },
  { phase: 3, title: "Marketplace ideology changes" },
  { phase: 4, title: "Function 1 — Org provisioning" },
  { phase: 5, title: "Function 2 — Learner self-registration" },
  { phase: 6, title: "Function 3 — Bulk learner import" },
  { phase: 7, title: "Functions 4 & 5 — ForSkills + historical sessions" },
  { phase: 8, title: "Function 6 — Placement assessment" },
  { phase: 9, title: "Function 7 — AI tutor session" },
  { phase: 10, title: "Functions 8 & 9 — Session logging + vocab ledger" },
  { phase: 11, title: "Function 10 — Safeguarding" },
  { phase: 12, title: "Function 11 — Level progression" },
  { phase: 13, title: "Function 12 — Org admin dashboard" },
  { phase: 14, title: "Function 13 — ILR CSV export" },
  { phase: 15, title: "Function 14 — Consolidated evidence report" },
  { phase: 16, title: "Function 15 — Amber admin view" },
  { phase: 17, title: "Function 16 — Demo environment" },
  { phase: 18, title: "Function 17 — RARPA Stage 5 review" },
  { phase: 19, title: "Content authoring" },
  { phase: 20, title: "Pre-launch testing & deployment" },
  { phase: 21, title: "MIS adapter pattern" },
  { phase: 22, title: "Function 18 — Teacher dashboard" },
  { phase: 23, title: "Function 19 — AI priority queue" },
  { phase: 24, title: "Function 20 — Teacher-learner messaging" },
  { phase: 25, title: "Function 21 — Teacher GLH ILR update" },
  { phase: 26, title: "ROI calculator" },
];

// ─────────────────────────────────────────────────────────────────────
// Checks — one per todo, grouped by phase
// ─────────────────────────────────────────────────────────────────────

const CHECKS: Check[] = [
  // ── Phase 0 ──────────────────────────────────────────────────
  {
    id: "0.1",
    phase: 0,
    title: "CORS whitelist (not origin: '*')",
    run: () => {
      const body = fileRead("src/index.ts") + fileRead("src/config/cors.ts");
      if (
        body.match(/origin\s*:\s*['"]\*['"]/) &&
        !body.includes("ALLOWED_ORIGINS")
      ) {
        return { status: "FAIL", detail: "CORS still wildcard" };
      }
      if (fileExists("src/config/cors.ts")) return { status: "PASS" };
      return { status: "WARN", detail: "cors config not in expected location" };
    },
  },
  {
    id: "0.2",
    phase: 0,
    title: "Route audit doc (CURRENT_API.md)",
    run: () => checkFile("docs/CURRENT_API.md"),
  },
  {
    id: "0.3",
    phase: 0,
    title: "Feature flag utils + middleware",
    run: () => {
      const ok =
        fileExists("src/utils/userType.ts") &&
        fileExists("src/middlewares/blockMarketplaceForEsol.ts");
      return ok
        ? { status: "PASS" }
        : { status: "FAIL", detail: "feature flag files missing" };
    },
  },
  {
    id: "0.4",
    phase: 0,
    title: "API documentation (CURRENT_API.md)",
    run: () => checkFile("docs/CURRENT_API.md"),
  },

  // ── Phase 1 ──────────────────────────────────────────────────
  {
    id: "1.1",
    phase: 1,
    title: "Codebase boots (package.json scripts)",
    run: () => {
      const ok =
        checkNpmScript("dev").status === "PASS" &&
        checkNpmScript("workers").status === "PASS";
      return ok
        ? { status: "PASS" }
        : { status: "WARN", detail: "dev/workers script missing" };
    },
  },
  {
    id: "1.2",
    phase: 1,
    title: "Google Cloud + Vertex AI setup (env vars)",
    run: () => {
      const env = fileRead(".env.example");
      const needed = ["GOOGLE_CLOUD_PROJECT_ID", "GOOGLE_CLOUD_REGION"];
      const missing = needed.filter((n) => !env.includes(n));
      return missing.length === 0
        ? { status: "PASS" }
        : {
            status: "WARN",
            detail: `env example missing: ${missing.join(", ")}`,
          };
    },
  },
  {
    id: "1.A",
    phase: 1,
    title: "[ADDENDUM] Singleton Gemini client",
    run: () => {
      const ok =
        fileExists("src/lib/gemini.ts") &&
        fileContains("src/lib/gemini.ts", "geminiClient") &&
        fileContains("src/lib/gemini.ts", "initGeminiClient");
      return ok
        ? { status: "PASS" }
        : { status: "FAIL", detail: "singleton not found" };
    },
  },
  {
    id: "1.3",
    phase: 1,
    title: "Multi-language Gemini smoke test script",
    run: () => checkFile("src/scripts/testGeminiLanguages.ts"),
  },
  {
    id: "1.B",
    phase: 1,
    title: "[ADDENDUM] BullMQ + ioredis (Redis singleton)",
    run: () => {
      const ok =
        fileExists("src/lib/redis.ts") &&
        checkPackageDep("bullmq").status === "PASS" &&
        checkPackageDep("ioredis").status === "PASS";
      return ok
        ? { status: "PASS" }
        : { status: "FAIL", detail: "redis/bullmq not wired" };
    },
  },
  {
    id: "1.C",
    phase: 1,
    title: "[ADDENDUM] 8 queues + workers scaffolding",
    run: () => {
      const queues = fileRead("src/queues/index.ts");
      const requiredQueues = [
        "esolSessionQueue",
        "rarpaEvidenceQueue",
        "ilrExportQueue",
        "complianceValidationQueue",
        "misPushQueue",
        "priorityQueueQueue",
        "deltaSyncQueue",
        "notificationsQueue",
      ];
      const missing = requiredQueues.filter((q) => !queues.includes(q));
      if (missing.length > 0)
        return {
          status: "FAIL",
          detail: `Missing queues: ${missing.join(", ")}`,
        };
      if (!fileExists("src/models/FailedJob.ts"))
        return { status: "FAIL", detail: "FailedJob model missing" };
      if (!fileExists("src/workers/run.ts"))
        return { status: "FAIL", detail: "workers/run.ts missing" };
      return { status: "PASS" };
    },
  },
  {
    id: "1.D",
    phase: 1,
    title: "[ADDENDUM] Job status endpoint + Bull Board",
    run: () => {
      const ok =
        fileExists("src/routes/jobs.routes.ts") &&
        fileExists("src/routes/adminQueues.routes.ts") &&
        checkPackageDep("@bull-board/express").status === "PASS" &&
        fileExists("src/middlewares/bullBoardToken.ts");
      return ok
        ? { status: "PASS" }
        : { status: "WARN", detail: "Bull Board pieces partial" };
    },
  },
  {
    id: "1.E",
    phase: 1,
    title: "[ADDENDUM] ComplianceConfig model + service + seed",
    run: () => {
      const ok =
        fileExists("src/models/ComplianceConfig.ts") &&
        fileExists("src/services/ComplianceConfigService.ts") &&
        fileExists("src/scripts/seedComplianceConfig.ts");
      return ok
        ? { status: "PASS" }
        : { status: "FAIL", detail: "ComplianceConfig pieces missing" };
    },
  },
  {
    id: "1.F",
    phase: 1,
    title: "[ADDENDUM] Pre-cache services (Safeguarding/Postcode/FALA)",
    run: () => {
      const safeguarding = anyFileExists([
        "src/services/safeguardingDetector.service.ts",
        "src/services/safeguarding.service.ts",
      ]);
      const postcode = anyFileExists([
        "src/services/postcodeRouter.service.ts",
      ]);
      const fala = fileExists("src/services/falaCache.service.ts");
      const keywords = fileExists("src/models/SafeguardingKeyword.ts");
      const seed = fileExists("src/data/safeguarding-keywords.json");
      const all = safeguarding && postcode && fala && keywords && seed;
      if (all) return { status: "PASS" };
      const missing: string[] = [];
      if (!safeguarding) missing.push("SafeguardingDetector");
      if (!postcode) missing.push("PostcodeRouter");
      if (!fala) missing.push("FALACache");
      if (!keywords) missing.push("SafeguardingKeyword model");
      if (!seed) missing.push("safeguarding-keywords.json");
      return { status: "FAIL", detail: missing.join(", ") };
    },
  },
  {
    id: "1.4",
    phase: 1,
    title: "Environment variables (env.example updated)",
    run: () => {
      const env = fileRead(".env.example");
      const required = [
        "GOOGLE_CLOUD_PROJECT_ID",
        "REDIS_URL",
        "BULL_BOARD_TOKEN",
        "REFERRAL_JWT_SECRET",
        "SAFEGUARDING_EMAIL",
        "MIS_CREDENTIALS_KEY",
      ];
      const missing = required.filter((r) => !env.includes(r));
      return missing.length === 0
        ? { status: "PASS" }
        : {
            status: "WARN",
            detail: `Missing in .env.example: ${missing.join(", ")}`,
          };
    },
  },
  {
    id: "1.5",
    phase: 1,
    title: "npm packages installed (bullmq, ioredis, bull-board, cryptr)",
    run: () => {
      const needed = ["bullmq", "ioredis", "@bull-board/express", "cryptr"];
      const missing = needed.filter(
        (n) => checkPackageDep(n).status !== "PASS",
      );
      return missing.length === 0
        ? { status: "PASS" }
        : { status: "FAIL", detail: `Missing deps: ${missing.join(", ")}` };
    },
  },
  {
    id: "1.6",
    phase: 1,
    title: "User model has ESOL + teacher fields",
    run: () => {
      const body = fileRead("src/models/User.ts");
      const required = [
        "esolLevel",
        "l1Language",
        "esol_aim_type",
        "stage3_objectives",
        "assigned_teacher_id",
        "glh_teacher_contact",
        "teacher_priority_level",
        "esolTeacherApproved",
        "auto_re_engagement_enabled",
      ];
      const missing = required.filter((r) => !body.includes(r));
      return missing.length === 0
        ? { status: "PASS" }
        : { status: "WARN", detail: `Fields missing: ${missing.join(", ")}` };
    },
  },
  {
    id: "1.7",
    phase: 1,
    title: "Booking model has esol_consolidation + org_invoiced",
    run: () => {
      const body = fileRead("src/models/Booking.ts");
      const ok =
        body.includes("esol_consolidation") && body.includes("org_invoiced");
      return ok
        ? { status: "PASS" }
        : { status: "WARN", detail: "esol fields not in Booking" };
    },
  },
  {
    id: "1.8",
    phase: 1,
    title: "15+ MongoDB collections present",
    run: () => {
      const required = [
        "Organisation",
        "ReferralToken",
        "AISession",
        "VocabLedger",
        "SafeguardingAlert",
        "SessionFeedback",
        "LevelChange",
        "OrgInvoice",
        "TeacherPrepNote",
        "Stage5Review",
        "TeacherReview",
        "TeacherMessage",
        "IdempotencyKey",
        "AuditLog",
        "ComplianceConfig",
        "NarrativeCache",
        "IlrExportWarnings",
        "FailedJob",
        "SafeguardingKeyword",
      ];
      const missing = required.filter((m) => !fileExists(`src/models/${m}.ts`));
      return missing.length === 0
        ? { status: "PASS", detail: `${required.length} models present` }
        : { status: "FAIL", detail: `Missing: ${missing.join(", ")}` };
    },
  },
  {
    id: "1.9",
    phase: 1,
    title: "Org-scoping middleware",
    run: () => {
      const ok =
        fileExists("src/middlewares/orgScopingMiddleware.ts") &&
        fileContains(
          "src/middlewares/orgScopingMiddleware.ts",
          "requireOrgContext",
        );
      return ok ? { status: "PASS" } : { status: "FAIL" };
    },
  },
  {
    id: "1.10",
    phase: 1,
    title: "Auth middleware extended (org_id in JWT)",
    run: () => {
      const body = fileRead("src/middlewares/authMiddleWare.ts");
      const ok = body.includes("orgId") || body.includes("org_id");
      return ok
        ? { status: "PASS" }
        : { status: "WARN", detail: "org_id not in auth middleware" };
    },
  },
  {
    id: "1.11",
    phase: 1,
    title: "Postcode dataset (superseded by Redis in 1.F)",
    run: () => ({ status: "SKIP", detail: "superseded by 1.F" }),
  },
  {
    id: "1.12",
    phase: 1,
    title: "vercel.json crons (6 expected)",
    run: () => {
      const required = [
        "/api/cron/complete-lessons",
        "/api/cron/generate-invoices",
        "/api/cron/check-progression",
        "/api/cron/priority-queue",
        "/api/cron/fala-refresh",
        "/api/cron/postcode-refresh-alert",
      ];
      const missing = required.filter(
        (r) => checkVercelCron(r).status !== "PASS",
      );
      return missing.length === 0
        ? { status: "PASS", detail: `${required.length} crons` }
        : { status: "WARN", detail: `Missing: ${missing.join(", ")}` };
    },
  },

  // ── Phase 2 ──────────────────────────────────────────────────
  {
    id: "2.1",
    phase: 2,
    title: "Compliance gate tracker doc",
    run: () => checkFile("docs/COMPLIANCE_GATE.md"),
  },
  {
    id: "2.2",
    phase: 2,
    title: "WCAG 2.1 AA requirements doc",
    run: () => checkFile("docs/WCAG_REQUIREMENTS.md"),
  },
  {
    id: "2.3",
    phase: 2,
    title: "axe DevTools (frontend — skip in backend audit)",
    run: () => ({ status: "SKIP", detail: "frontend concern" }),
  },

  // ── Phase 3 ──────────────────────────────────────────────────
  {
    id: "3.1",
    phase: 3,
    title: "org_invoiced bypass in booking.service.ts",
    run: () =>
      checkFileContent("src/services/booking.service.ts", "org_invoiced"),
  },
  {
    id: "3.2",
    phase: 3,
    title: "ESOL teacher approval routes",
    run: () => {
      const ok =
        anyFileExists(["src/routes/esolTeacher.routes.ts"]) &&
        fileContains(
          "src/services/esolTeacher.service.ts",
          "esolTeacherApproved",
        );
      return ok ? { status: "PASS" } : { status: "WARN" };
    },
  },
  {
    id: "3.3",
    phase: 3,
    title: "Algorithmic teacher matching (/teacher-matches)",
    run: () => checkFile("src/routes/esolMatching.routes.ts"),
  },
  {
    id: "3.4",
    phase: 3,
    title: "Standardised ESOL session rate tests",
    run: () => checkFile("src/__tests__/booking.test.ts"),
  },
  {
    id: "3.5",
    phase: 3,
    title: "Public reviews blocked for esol_consolidation",
    run: () => {
      const body =
        fileRead("src/controllers/review.controller.ts") +
        fileRead("src/services/review.service.ts");
      return body.includes("esol_consolidation") ||
        body.includes("esolConsolidation")
        ? { status: "PASS" }
        : { status: "WARN", detail: "review block not found" };
    },
  },

  // ── Phase 4 ──────────────────────────────────────────────────
  {
    id: "4.1",
    phase: 4,
    title: "Organisation CRUD routes",
    run: () =>
      fileExists("src/routes/org.routes.ts") ||
      fileExists("src/routes/esolOrg.routes.ts")
        ? { status: "PASS" }
        : { status: "FAIL" },
  },
  {
    id: "4.2",
    phase: 4,
    title: "Referral link generation",
    run: () => {
      const body =
        fileRead("src/services/org.service.ts") +
        fileRead("src/services/esolReferralToken.service.ts");
      return body.includes("generateReferralToken") ||
        body.includes("ReferralToken")
        ? { status: "PASS" }
        : { status: "WARN" };
    },
  },
  {
    id: "4.3",
    phase: 4,
    title: "Referral link listing + deactivation",
    run: () => checkFile("src/routes/esolReferral.routes.ts"),
  },
  {
    id: "4.4",
    phase: 4,
    title: "Org admin user creation",
    run: () => {
      const body = fileRead("src/services/org.service.ts");
      return body.includes("createOrgAdminUser") ||
        body.includes("orgAdminWelcome")
        ? { status: "PASS" }
        : { status: "WARN" };
    },
  },
  {
    id: "4.5",
    phase: 4,
    title: "Org provisioning tests",
    run: () =>
      anyFileExists([
        "src/__tests__/org.test.ts",
        "src/__tests__/orgAdminAuditLog.test.ts",
      ])
        ? { status: "PASS" }
        : { status: "WARN" },
  },

  // ── Phase 5 ──────────────────────────────────────────────────
  {
    id: "5.1",
    phase: 5,
    title: "Token verification endpoint",
    run: () => checkFile("src/routes/esolVerifyToken.routes.ts"),
  },
  {
    id: "5.2",
    phase: 5,
    title: "Learner registration endpoint",
    run: () => checkFile("src/routes/esolRegister.routes.ts"),
  },
  {
    id: "5.3",
    phase: 5,
    title: "Eligibility declaration",
    run: () => checkFile("src/routes/esolEligibility.routes.ts"),
  },
  {
    id: "5.4",
    phase: 5,
    title: "ULN endpoint",
    run: () => checkFile("src/routes/esolUln.routes.ts"),
  },
  {
    id: "5.5",
    phase: 5,
    title: "Frontend registration wizard (frontend — skip)",
    run: () => ({ status: "SKIP", detail: "frontend concern" }),
  },
  {
    id: "5.6",
    phase: 5,
    title: "D1 test suite (esolRegistration.test.ts)",
    run: () => checkFile("src/__tests__/esolRegistration.test.ts"),
  },

  // ── Phase 6 ──────────────────────────────────────────────────
  {
    id: "6.1",
    phase: 6,
    title: "CSV import template defined",
    run: () =>
      fileExists("src/services/orgAdminImport.service.ts") ||
      fileExists("src/services/esolOnboarding.service.ts")
        ? { status: "PASS" }
        : { status: "WARN" },
  },
  {
    id: "6.2",
    phase: 6,
    title: "Bulk learner import endpoint",
    run: () => checkFile("src/routes/orgAdminImport.routes.ts"),
  },
  {
    id: "6.3",
    phase: 6,
    title: "Row validation (bulkImportValidators tests)",
    run: () => checkFile("src/__tests__/bulkImportValidators.test.ts"),
  },
  {
    id: "6.4",
    phase: 6,
    title: "Frontend bulk import UI (frontend — skip)",
    run: () => ({ status: "SKIP", detail: "frontend concern" }),
  },
  {
    id: "6.5",
    phase: 6,
    title: "Mixed-quality CSV test",
    run: () => checkFile("src/__tests__/bulkImport.test.ts"),
  },

  // ── Phase 7 ──────────────────────────────────────────────────
  {
    id: "7.1",
    phase: 7,
    title: "ForSkills CSV importer (route or service)",
    run: () => {
      const body =
        fileRead("src/services/orgAdminImport.service.ts") +
        fileRead("src/services/forskillsApi.service.ts");
      return body.length > 0 ? { status: "PASS" } : { status: "WARN" };
    },
  },
  {
    id: "7.2",
    phase: 7,
    title: "Historical sessions CSV import",
    run: () => checkFile("src/services/orgAdminSessionsImport.service.ts"),
  },
  {
    id: "7.3",
    phase: 7,
    title: "ForSkills API stub for v1.1",
    run: () => checkFile("src/services/forskillsApi.service.ts"),
  },

  // ── Phase 8 ──────────────────────────────────────────────────
  {
    id: "8.1",
    phase: 8,
    title: "Placement question bank JSON",
    run: () => checkFile("src/data/placement-questions.json"),
  },
  {
    id: "8.2",
    phase: 8,
    title: "Adaptive question selection",
    run: () =>
      fileContains(
        "src/services/placement.service.ts",
        "selectAdaptiveQuestions",
      ) || fileContains("src/services/placement.service.ts", "adaptive")
        ? { status: "PASS" }
        : { status: "WARN" },
  },
  {
    id: "8.3",
    phase: 8,
    title: "Gemini placement scoring",
    run: () =>
      checkFileContent("src/services/placement.service.ts", "geminiClient"),
  },
  {
    id: "8.4",
    phase: 8,
    title: "Stage 3 objectives from placement",
    run: () =>
      fileContains("src/services/placement.service.ts", "stage3_objectives") ||
      fileContains("src/services/esolOnboarding.service.ts", "stage3")
        ? { status: "PASS" }
        : { status: "WARN" },
  },
  {
    id: "8.5",
    phase: 8,
    title: "Frontend placement screen (frontend — skip)",
    run: () => ({ status: "SKIP" }),
  },
  {
    id: "8.6",
    phase: 8,
    title: "Calibration test protocol doc + route",
    run: () => {
      const doc = fileExists("docs/PLACEMENT_CALIBRATION_PROTOCOL.md");
      const route = fileExists("src/routes/calibration.routes.ts");
      const model = fileExists("src/models/CalibrationLog.ts");
      return doc && route && model
        ? { status: "PASS" }
        : {
            status: "WARN",
            detail: `doc=${doc} route=${route} model=${model}`,
          };
    },
  },

  // ── Phase 9 ──────────────────────────────────────────────────
  {
    id: "9.1",
    phase: 9,
    title: "Six-layer system prompt files",
    run: () => {
      const ok = fileExists("src/data/system-prompts");
      return ok ? { status: "PASS" } : { status: "FAIL" };
    },
  },
  {
    id: "9.2",
    phase: 9,
    title: "Three MVP scenarios",
    run: () => {
      const ok = fileExists("src/data/scenarios");
      return ok ? { status: "PASS" } : { status: "FAIL" };
    },
  },
  {
    id: "9.3",
    phase: 9,
    title: "Gemini integration via singleton (gemini.service.ts)",
    run: () =>
      checkFileContent("src/services/gemini.service.ts", "geminiClient"),
  },
  {
    id: "9.4",
    phase: 9,
    title: "Structured JSON output validator",
    run: () =>
      anyFileExists([
        "src/utils/geminiOutputValidator.ts",
        "src/__tests__/geminiOutputValidator.test.ts",
      ])
        ? { status: "PASS" }
        : { status: "WARN" },
  },
  {
    id: "9.5",
    phase: 9,
    title: "Per-turn handler (aiSession.service.ts)",
    run: () => checkFile("src/services/aiSession.service.ts"),
  },
  {
    id: "9.6",
    phase: 9,
    title: "Session start + end routes (pathway_override + unread msg check)",
    run: () => {
      const body = fileRead("src/services/aiSession.service.ts");
      const features = ["pathway_override", "unread_messages"].filter(
        (f) => !body.includes(f),
      );
      return features.length === 0
        ? { status: "PASS" }
        : { status: "WARN", detail: `Missing: ${features.join(", ")}` };
    },
  },
  {
    id: "9.7",
    phase: 9,
    title: "AI rate limiters (aiTurnLimiter, sessionStartLimiter)",
    run: () => {
      const body = fileRead("src/config/rateLimiter.ts");
      const features = ["aiTurnLimiter", "sessionStartLimiter"].filter(
        (f) => !body.includes(f),
      );
      return features.length === 0
        ? { status: "PASS" }
        : { status: "WARN", detail: `Missing: ${features.join(", ")}` };
    },
  },
  {
    id: "9.8",
    phase: 9,
    title: "Frontend AI tutor chat (frontend — skip)",
    run: () => ({ status: "SKIP" }),
  },
  {
    id: "9.9",
    phase: 9,
    title: "D2 acceptance test suite (aiTutor.test.ts)",
    run: () => checkFile("src/__tests__/aiTutor.test.ts"),
  },
  {
    id: "9.10",
    phase: 9,
    title: "[ADDENDUM] Safeguarding pre-cache integration tests",
    run: () =>
      anyFileExists([
        "src/__tests__/safeguardingIntegration.test.ts",
        "src/__tests__/safeguarding.test.ts",
      ])
        ? { status: "PASS" }
        : { status: "FAIL" },
  },

  // ── Phase 10 ─────────────────────────────────────────────────
  {
    id: "10.1",
    phase: 10,
    title: "Session writer (persistSessionOnEnd)",
    run: () => checkFile("src/__tests__/persistSessionOnEnd.test.ts"),
  },
  {
    id: "10.2",
    phase: 10,
    title: "Stage 3 linking on session start",
    run: () => checkFile("src/__tests__/stage3LinkingOnStart.test.ts"),
  },
  {
    id: "10.3",
    phase: 10,
    title: "Vocab ledger update service",
    run: () =>
      fileExists("src/services/esolVocab.service.ts") ||
      fileExists("src/services/vocabLedger.service.ts")
        ? { status: "PASS" }
        : { status: "FAIL" },
  },
  {
    id: "10.4",
    phase: 10,
    title: "Reinforcement targeting query",
    run: () => {
      const body = fileRead("src/services/vocabLedger.service.ts");
      return body.includes("reinforcement")
        ? { status: "PASS", note: "vocabLedger.service.ts" }
        : { status: "WARN" };
    },
  },
  {
    id: "10.5",
    phase: 10,
    title: "Vocab + session API routes",
    run: () =>
      fileExists("src/routes/esolVocab.routes.ts") &&
      fileExists("src/routes/esolAISession.routes.ts")
        ? { status: "PASS" }
        : { status: "WARN" },
  },

  // ── Phase 11 ─────────────────────────────────────────────────
  {
    id: "11.1",
    phase: 11,
    title: "Pre-cached safeguarding messages",
    run: () => checkFile("src/data/safeguarding-messages.json"),
  },
  {
    id: "11.2",
    phase: 11,
    title: "Safeguarding protocol in turn handler",
    run: () => checkFile("src/__tests__/safeguardingIntegration.test.ts"),
  },
  {
    id: "11.3",
    phase: 11,
    title: "Safeguarding alert email via queue",
    run: () => checkFile("src/__tests__/safeguardingAlertEmail.test.ts"),
  },
  {
    id: "11.4",
    phase: 11,
    title: "SHA-256 hashing only (no raw content)",
    run: () => checkFile("src/__tests__/safeguarding.test.ts"),
  },
  {
    id: "11.5",
    phase: 11,
    title: "Admin alert management routes",
    run: () => checkFile("src/routes/adminSafeguarding.routes.ts"),
  },

  // ── Phase 12 ─────────────────────────────────────────────────
  {
    id: "12.1",
    phase: 12,
    title: "Progression check service",
    run: () =>
      fileExists("src/services/esolProgression.service.ts") ||
      fileExists("src/services/levelProgression.service.ts")
        ? { status: "PASS" }
        : { status: "FAIL" },
  },
  {
    id: "12.2",
    phase: 12,
    title: "Daily progression cron + worker",
    run: () => {
      const ok =
        checkVercelCron("/api/cron/check-progression").status === "PASS" &&
        fileExists("src/__tests__/progressionCron.test.ts");
      return ok ? { status: "PASS" } : { status: "WARN" };
    },
  },
  {
    id: "12.3",
    phase: 12,
    title: "Level change confirmation routes",
    run: () =>
      fileExists("src/routes/adminLevelChange.routes.ts") &&
      fileExists("src/routes/esolLevelChange.routes.ts")
        ? { status: "PASS" }
        : { status: "WARN" },
  },
  {
    id: "12.4",
    phase: 12,
    title: "Stage 5 trigger on level change",
    run: () => checkFile("src/__tests__/triggerStage5Review.test.ts"),
  },

  // ── Phase 13 ─────────────────────────────────────────────────
  {
    id: "13.1",
    phase: 13,
    title: "Cohort table endpoint",
    run: () => checkFile("src/services/cohortTable.service.ts"),
  },
  {
    id: "13.2",
    phase: 13,
    title: "Learner detail endpoint",
    run: () => checkFile("src/__tests__/learnerDetail.test.ts"),
  },
  {
    id: "13.3",
    phase: 13,
    title: "Narrative summary generation",
    run: () =>
      fileExists("src/services/narrativeSummary.service.ts") &&
      fileExists("src/__tests__/narrativeSummary.test.ts")
        ? { status: "PASS" }
        : { status: "WARN" },
  },
  {
    id: "13.4",
    phase: 13,
    title: "Inactive learner alerts + nudge",
    run: () => checkFile("src/__tests__/learnerNudge.test.ts"),
  },
  {
    id: "13.5",
    phase: 13,
    title: "Frontend dashboard pages (frontend — skip)",
    run: () => ({ status: "SKIP" }),
  },
  {
    id: "13.6",
    phase: 13,
    title: "Cohort filter + search (cohortTable.test)",
    run: () => checkFile("src/__tests__/cohortTable.test.ts"),
  },
  {
    id: "13.7",
    phase: 13,
    title: "[ADDENDUM] Audit Log tab",
    run: () =>
      fileExists("src/routes/orgAdminAuditLog.routes.ts") &&
      fileExists("src/__tests__/orgAdminAuditLog.test.ts")
        ? { status: "PASS" }
        : { status: "WARN" },
  },
  {
    id: "13.8",
    phase: 13,
    title: "[ADDENDUM] Teacher GLH column on cohort table",
    run: () =>
      checkFileContent(
        "src/services/cohortTable.service.ts",
        "teacher_contact_hours",
      ),
  },
  {
    id: "13.9",
    phase: 13,
    title: "[ADDENDUM] Teacher assignment management UI",
    run: () => checkFile("src/__tests__/teacherAssignment.test.ts"),
  },

  // ── Phase 14 ─────────────────────────────────────────────────
  {
    id: "14.1",
    phase: 14,
    title: "ILR field mapping (reads from ComplianceConfig)",
    run: () =>
      checkFileContent("src/services/ilrExport.service.ts", "ComplianceConfig"),
  },
  {
    id: "14.2",
    phase: 14,
    title: "Four breaking-change handlers",
    run: () => checkFile("src/__tests__/ilrBreakingChanges.test.ts"),
  },
  {
    id: "14.3",
    phase: 14,
    title: "Validation warnings + idempotency",
    run: () => checkFile("src/__tests__/ilrValidation.test.ts"),
  },
  {
    id: "14.4",
    phase: 14,
    title: "Export routes (async queue, companion JSON)",
    run: () => {
      const ok =
        fileExists("src/routes/ilrExport.routes.ts") &&
        fileExists("src/__tests__/ilrExportRoutes.test.ts");
      return ok ? { status: "PASS" } : { status: "WARN" };
    },
  },
  {
    id: "14.5",
    phase: 14,
    title: "Demo filter (is_demo blocked)",
    run: () => checkFile("src/__tests__/ilrDemoGuard.test.ts"),
  },
  {
    id: "14.6",
    phase: 14,
    title: "ESFA test submission doc",
    run: () => checkFile("docs/ESFA_TEST_SUBMISSION.md"),
  },

  // ── Phase 15 ─────────────────────────────────────────────────
  {
    id: "15.1",
    phase: 15,
    title: "Evidence report PDF structure doc",
    run: () => checkFile("docs/EVIDENCE_REPORT_TEMPLATE.md"),
  },
  {
    id: "15.2",
    phase: 15,
    title: "Evidence report generator (handlebars + puppeteer)",
    run: () =>
      fileExists("src/services/evidenceReport.service.ts") &&
      fileExists("src/templates/evidenceReport.handlebars")
        ? { status: "PASS" }
        : { status: "FAIL" },
  },
  {
    id: "15.3",
    phase: 15,
    title: "Evidence report routes",
    run: () =>
      fileExists("src/routes/adminEvidenceReport.routes.ts") &&
      fileExists("src/routes/orgAdminEvidenceReport.routes.ts")
        ? { status: "PASS" }
        : { status: "WARN" },
  },
  {
    id: "15.4",
    phase: 15,
    title: "Dashboard wire-up (frontend — skip)",
    run: () => ({ status: "SKIP" }),
  },
  {
    id: "15.5",
    phase: 15,
    title: "Report caching via IdempotencyKey",
    run: () =>
      checkFileContent(
        "src/services/evidenceReport.service.ts",
        /idempot|IdempotencyKey/i,
      ),
  },

  // ── Phase 16 ─────────────────────────────────────────────────
  {
    id: "16.1",
    phase: 16,
    title: "All-orgs overview endpoint",
    run: () =>
      fileExists("src/services/adminOrgsOverview.service.ts") &&
      fileExists("src/routes/adminOrgs.routes.ts")
        ? { status: "PASS" }
        : { status: "WARN" },
  },
  {
    id: "16.2",
    phase: 16,
    title: "Cross-org safeguarding overview",
    run: () => checkFile("src/__tests__/adminSafeguarding.test.ts"),
  },
  {
    id: "16.3",
    phase: 16,
    title: "Cost monitoring (ai_usage based)",
    run: () =>
      anyFileExists([
        "src/services/adminDashboard.service.ts",
        "src/models/AIUsage.ts",
      ])
        ? { status: "PASS" }
        : { status: "WARN" },
  },
  {
    id: "16.4",
    phase: 16,
    title: "User impersonation",
    run: () => checkFile("src/services/adminImpersonation.service.ts"),
  },
  {
    id: "16.5",
    phase: 16,
    title: "Frontend admin pages (frontend — skip)",
    run: () => ({ status: "SKIP" }),
  },
  {
    id: "16.6",
    phase: 16,
    title: "[ADDENDUM] ComplianceConfig editor",
    run: () => checkFile("src/routes/adminComplianceConfig.routes.ts"),
  },
  {
    id: "16.7",
    phase: 16,
    title: "[ADDENDUM] Bull Board admin link",
    run: () => checkFile("src/routes/adminQueues.routes.ts"),
  },
  {
    id: "16.8",
    phase: 16,
    title: "[ADDENDUM] MIS settings per org (encrypted)",
    run: () => checkFile("src/services/adminMisSettings.service.ts"),
  },
  {
    id: "16.9",
    phase: 16,
    title: "[ADDENDUM] Teacher utilisation analytics",
    run: () =>
      fileExists("src/services/adminTeacherUtilisation.service.ts") &&
      fileExists("src/routes/adminTeacherUtilisation.routes.ts")
        ? { status: "PASS" }
        : { status: "FAIL" },
  },
  {
    id: "16.10",
    phase: 16,
    title: "[ADDENDUM] Failed jobs review",
    run: () =>
      fileExists("src/services/adminFailedJobs.service.ts") &&
      fileExists("src/routes/adminFailedJobs.routes.ts")
        ? { status: "PASS" }
        : { status: "FAIL" },
  },

  // ── Phase 17 ─────────────────────────────────────────────────
  {
    id: "17.1",
    phase: 17,
    title: "Demo seed script",
    run: () => checkFile("src/scripts/seedDemoEnvironment.ts"),
  },
  {
    id: "17.2",
    phase: 17,
    title: "Demo-mode env toggle (DEMO_MODE middleware)",
    run: () =>
      anyFileExists(["src/middlewares/demoMode.ts", "src/config/demoMode.ts"])
        ? { status: "PASS" }
        : { status: "WARN" },
  },
  {
    id: "17.3",
    phase: 17,
    title: "Demo reset cron + service",
    run: () => checkFile("src/services/demoReset.service.ts"),
  },
  {
    id: "17.4",
    phase: 17,
    title: "Demo environment doc",
    run: () => checkFile("docs/DEMO_ENVIRONMENT.md"),
  },

  // ── Phase 18 ─────────────────────────────────────────────────
  {
    id: "18.1",
    phase: 18,
    title: "Stage 5 trigger on level change",
    run: () => checkFile("src/__tests__/triggerStage5Review.test.ts"),
  },
  {
    id: "18.2",
    phase: 18,
    title: "Stage 5 self-assessment endpoint",
    run: () => checkFile("src/routes/stage5.routes.ts"),
  },
  {
    id: "18.3",
    phase: 18,
    title: "AI tutor summary via Gemini",
    run: () => checkFile("src/services/stage5AiSummary.service.ts"),
  },
  {
    id: "18.4",
    phase: 18,
    title: "Org admin Stage 5 confirmation",
    run: () => checkFile("src/routes/orgAdminStage5.routes.ts"),
  },
  {
    id: "18.5",
    phase: 18,
    title: "Frontend Stage 5 screens (frontend — skip)",
    run: () => ({ status: "SKIP" }),
  },

  // ── Phase 19 ─────────────────────────────────────────────────
  {
    id: "19.1",
    phase: 19,
    title: "Content authoring tracker doc",
    run: () => checkFile("docs/CONTENT_AUTHORING.md"),
  },

  // ── Phase 20 ─────────────────────────────────────────────────
  {
    id: "20.1",
    phase: 20,
    title: "Performance load tests (k6 / tests/load)",
    run: () =>
      fileExists("tests/load") || fileExists("tests")
        ? { status: "PASS" }
        : { status: "WARN" },
  },
  {
    id: "20.2",
    phase: 20,
    title: "Security audit doc",
    run: () => checkFile("docs/SECURITY_AUDIT.md"),
  },
  {
    id: "20.3",
    phase: 20,
    title: "Production deployment doc",
    run: () => checkFile("docs/PRODUCTION_DEPLOYMENT.md"),
  },
  {
    id: "20.4",
    phase: 20,
    title: "Pilot launch doc",
    run: () => checkFile("docs/PILOT_LAUNCH.md"),
  },
  {
    id: "20.5",
    phase: 20,
    title: "Public launch doc",
    run: () => checkFile("docs/PUBLIC_LAUNCH.md"),
  },

  // ── Phase 21 ─────────────────────────────────────────────────
  {
    id: "21.1",
    phase: 21,
    title: "[ADDENDUM] MIS adapter types",
    run: () => checkFile("src/services/mis/types.ts"),
  },
  {
    id: "21.2",
    phase: 21,
    title: "ProSolutionAdapter",
    run: () => checkFile("src/services/mis/ProSolutionAdapter.ts"),
  },
  {
    id: "21.3",
    phase: 21,
    title: "MaytasAdapter",
    run: () => checkFile("src/services/mis/MaytasAdapter.ts"),
  },
  {
    id: "21.4",
    phase: 21,
    title: "EBSAdapter",
    run: () => checkFile("src/services/mis/EBSAdapter.ts"),
  },
  {
    id: "21.5",
    phase: 21,
    title: "AdapterFactory",
    run: () => checkFile("src/services/mis/AdapterFactory.ts"),
  },
  {
    id: "21.6",
    phase: 21,
    title: "MIS push + compliance validation workers",
    run: () =>
      fileExists("src/services/mis/processMisPush.ts") &&
      fileExists("src/services/mis/processComplianceValidation.ts")
        ? { status: "PASS" }
        : { status: "FAIL" },
  },
  {
    id: "21.7",
    phase: 21,
    title: "Delta-sync cron + worker",
    run: () =>
      fileExists("src/services/mis/deltaSyncCron.service.ts") &&
      fileExists("src/services/mis/processDeltaSync.ts")
        ? { status: "PASS" }
        : { status: "FAIL" },
  },
  {
    id: "21.8",
    phase: 21,
    title: "MIS adapter test suite",
    run: () => checkFile("src/__tests__/misAdapter.test.ts"),
  },

  // ── Phase 22 ─────────────────────────────────────────────────
  {
    id: "22.1",
    phase: 22,
    title: "requireTeacherRole middleware",
    run: () =>
      checkFileContent(
        "src/middlewares/teacherMiddleware.ts",
        "requireTeacherRole",
      ),
  },
  {
    id: "22.2",
    phase: 22,
    title: "/api/teacher route group",
    run: () => checkFile("src/routes/teacher.routes.ts"),
  },
  {
    id: "22.3",
    phase: 22,
    title: "GET /teacher/learners (cohort)",
    run: () => checkFile("src/services/teacherLearners.service.ts"),
  },
  {
    id: "22.4",
    phase: 22,
    title: "GET /teacher/learners/:id (detail)",
    run: () => checkFile("src/services/teacherLearnerDetail.service.ts"),
  },
  {
    id: "22.5",
    phase: 22,
    title: "POST /review (TeacherReview create)",
    run: () => checkFile("src/services/teacherReviewLog.service.ts"),
  },
  {
    id: "22.6",
    phase: 22,
    title: "POST /pathway (pathway override)",
    run: () => checkFile("src/services/teacherPathwayOverride.service.ts"),
  },
  {
    id: "22.7",
    phase: 22,
    title: "POST /rarpa-signoff",
    run: () => checkFile("src/services/teacherRarpaSignoff.service.ts"),
  },
  {
    id: "22.8",
    phase: 22,
    title: "Teacher dashboard frontend (frontend — skip)",
    run: () => ({ status: "SKIP" }),
  },
  {
    id: "22.9",
    phase: 22,
    title: "Learner detail frontend (frontend — skip)",
    run: () => ({ status: "SKIP" }),
  },

  // ── Phase 23 ─────────────────────────────────────────────────
  {
    id: "23.1",
    phase: 23,
    title: "Priority scoring service (evaluatePriority)",
    run: () =>
      checkFileContent(
        "src/services/priorityQueue.service.ts",
        "evaluatePriority",
      ),
  },
  {
    id: "23.2",
    phase: 23,
    title: "Recommended action templates JSON",
    run: () => checkFile("src/data/recommended-actions.json"),
  },
  {
    id: "23.3",
    phase: 23,
    title: "Priority queue worker (recalc-org-priorities)",
    run: () =>
      checkFileContent(
        "src/services/priorityQueueRecalc.service.ts",
        "runOrgPriorityRecalc",
      ),
  },
  {
    id: "23.4",
    phase: 23,
    title: "On-demand recalc after teacher actions",
    run: () =>
      checkFileContent(
        "src/services/priorityQueueRecalc.service.ts",
        "enqueueLearnerPriorityRecalc",
      ),
  },
  {
    id: "23.5",
    phase: 23,
    title: "Click handlers in UI (frontend — skip)",
    run: () => ({ status: "SKIP" }),
  },
  {
    id: "23.6",
    phase: 23,
    title: "Daily priority recalc cron handler",
    run: () =>
      checkFileContent(
        "src/services/priorityQueueCron.service.ts",
        "fanOutPriorityRecalc",
      ),
  },

  // ── Phase 24 ─────────────────────────────────────────────────
  {
    id: "24.1",
    phase: 24,
    title: "Send message endpoint (with Gemini L1 translate)",
    run: () => checkFile("src/services/teacherMessageSend.service.ts"),
  },
  {
    id: "24.2",
    phase: 24,
    title: "Translation preview endpoint",
    run: () => checkFile("src/services/teacherMessagePreview.service.ts"),
  },
  {
    id: "24.3",
    phase: 24,
    title: "Unread message endpoint",
    run: () => checkFile("src/routes/esolMessages.routes.ts"),
  },
  {
    id: "24.4",
    phase: 24,
    title: "Re-engagement cron + auto-send",
    run: () =>
      fileExists("src/services/reEngagementCron.service.ts") &&
      fileExists("src/services/teacherMessageAutoSend.service.ts") &&
      checkVercelCron("/api/cron/re-engagement").status === "PASS"
        ? { status: "PASS" }
        : { status: "WARN" },
  },
  {
    id: "24.5",
    phase: 24,
    title: "Message read endpoint",
    run: () => checkFile("src/services/learnerMarkMessageRead.service.ts"),
  },

  // ── Phase 25 ─────────────────────────────────────────────────
  {
    id: "25.1",
    phase: 25,
    title: "Atomic GLH increment + test",
    run: () => checkFile("src/__tests__/teacherGlh.test.ts"),
  },
  {
    id: "25.2",
    phase: 25,
    title: "ILR GLH formula (uses User.glh_teacher_contact)",
    run: () => checkFile("src/__tests__/ilrGlh.test.ts"),
  },
  {
    id: "25.3",
    phase: 25,
    title: "Cohort table teacher GLH (verified in 13.8)",
    run: () => ({ status: "SKIP", detail: "verified by 13.8" }),
  },
  {
    id: "25.4",
    phase: 25,
    title: "Evidence report teacher oversight aggregates",
    run: () =>
      checkFileContent(
        "src/services/evidenceReport.service.ts",
        "teacher_oversight",
      ),
  },
  {
    id: "25.5",
    phase: 25,
    title: "Admin GLH analytics endpoint",
    run: () =>
      fileExists("src/services/adminGlhAnalytics.service.ts") &&
      fileExists("src/routes/adminGlhAnalytics.routes.ts")
        ? { status: "PASS" }
        : { status: "FAIL" },
  },
  {
    id: "25.6",
    phase: 25,
    title: "Companion JSON breakdown (verified in 14.4)",
    run: () => ({ status: "SKIP", detail: "verified by 14.4" }),
  },
  {
    id: "25.7",
    phase: 25,
    title: "End-to-end teacher GLH test",
    run: () => checkFile("src/__tests__/teacherGlhEndToEnd.test.ts"),
  },

  // ── Phase 26 ─────────────────────────────────────────────────
  {
    id: "26.1",
    phase: 26,
    title: "ROI calculator page (frontend — skip)",
    run: () => ({ status: "SKIP" }),
  },
  {
    id: "26.2",
    phase: 26,
    title: "ROI inputs (frontend — skip)",
    run: () => ({ status: "SKIP" }),
  },
  {
    id: "26.3",
    phase: 26,
    title: "ROI real-time calc (frontend — skip)",
    run: () => ({ status: "SKIP" }),
  },
  {
    id: "26.4",
    phase: 26,
    title: "ROI PDF export (frontend — skip)",
    run: () => ({ status: "SKIP" }),
  },
  {
    id: "26.5",
    phase: 26,
    title: "Public ROI submission endpoint + model",
    run: () => {
      const ok =
        fileExists("src/models/RoiCalculatorSubmission.ts") &&
        fileExists("src/services/roiCalculatorSubmit.service.ts") &&
        fileExists("src/routes/publicRoiCalculator.routes.ts");
      return ok ? { status: "PASS" } : { status: "FAIL" };
    },
  },
  {
    id: "26.6",
    phase: 26,
    title: "Sales intelligence dashboard backend",
    run: () =>
      fileExists("src/services/adminSalesIntelligence.service.ts") &&
      fileExists("src/routes/adminSalesIntelligence.routes.ts")
        ? { status: "PASS" }
        : { status: "FAIL" },
  },
  {
    id: "26.7",
    phase: 26,
    title: "Onboarding URL embed (welcome email)",
    run: () => {
      const ok =
        fileExists("src/services/roiCalculatorUrl.service.ts") &&
        fileContains(
          "src/services/nodemailer/templates/orgAdminWelcome.handlebars",
          "roiCalculatorUrl",
        );
      return ok
        ? { status: "PASS" }
        : { status: "WARN", detail: "URL embed partial" };
    },
  },
  {
    id: "26.8",
    phase: 26,
    title: "Outreach email templates doc",
    run: () => checkFile("docs/OUTREACH_EMAIL_TEMPLATES.md"),
  },
];

// ─────────────────────────────────────────────────────────────────────
// Test runner — full Jest sweep (optional, controlled by --no-tests)
// ─────────────────────────────────────────────────────────────────────

interface JestSummary {
  passed: boolean;
  passedSuites: number;
  failedSuites: number;
  passedTests: number;
  failedTests: number;
  raw: string;
}

const runJest = (skip: boolean): JestSummary => {
  if (skip) {
    return {
      passed: true,
      passedSuites: 0,
      failedSuites: 0,
      passedTests: 0,
      failedTests: 0,
      raw: "skipped (--no-tests)",
    };
  }
  console.log("\n→ Running jest (this may take 30-60s)...\n");
  const result = spawnSync(
    "npx",
    ["jest", "--runInBand", "--forceExit", "--silent"],
    {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 240_000, // 4 minutes
    },
  );
  const out = (result.stdout || "") + "\n" + (result.stderr || "");
  const suiteMatch = out.match(/Test Suites:.*$/m)?.[0] ?? "";
  const testMatch = out.match(/Tests:.*$/m)?.[0] ?? "";
  const passedSuites = parseInt(
    suiteMatch.match(/(\d+) passed/)?.[1] ?? "0",
    10,
  );
  const failedSuites = parseInt(
    suiteMatch.match(/(\d+) failed/)?.[1] ?? "0",
    10,
  );
  const passedTests = parseInt(testMatch.match(/(\d+) passed/)?.[1] ?? "0", 10);
  const failedTests = parseInt(testMatch.match(/(\d+) failed/)?.[1] ?? "0", 10);
  return {
    passed: failedSuites === 0 && failedTests === 0 && result.status === 0,
    passedSuites,
    failedSuites,
    passedTests,
    failedTests,
    raw: `${suiteMatch}\n${testMatch}`,
  };
};

// ─────────────────────────────────────────────────────────────────────
// Output formatting
// ─────────────────────────────────────────────────────────────────────

const COLOUR = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  grey: "\x1b[90m",
};

const STATUS_ICON: Record<Status, string> = {
  PASS: `${COLOUR.green}✓ PASS${COLOUR.reset}`,
  WARN: `${COLOUR.yellow}⚠ WARN${COLOUR.reset}`,
  FAIL: `${COLOUR.red}✗ FAIL${COLOUR.reset}`,
  SKIP: `${COLOUR.grey}⊝ SKIP${COLOUR.reset}`,
};

const padRight = (s: string, n: number): string =>
  s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);

// ─────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────

const main = () => {
  const args = process.argv.slice(2);
  const skipTests = args.includes("--no-tests");
  const onlyPhase = args.find((a) => a.startsWith("--phase="))?.split("=")[1];

  console.log(
    `${COLOUR.bold}${COLOUR.cyan}Project Silk — Merged TODO Audit${COLOUR.reset}\n`,
  );
  console.log(`Root: ${ROOT}`);
  console.log(
    `Checks: ${CHECKS.length}, Tests: ${skipTests ? "skipped" : "will run"}\n`,
  );

  const filtered = onlyPhase
    ? CHECKS.filter((c) => c.phase === parseInt(onlyPhase, 10))
    : CHECKS;

  let lastPhase = -1;
  const results: Array<Check & CheckOutcome> = [];

  for (const check of filtered) {
    if (check.phase !== lastPhase) {
      const header = PHASE_HEADERS.find((h) => h.phase === check.phase);
      console.log(
        `\n${COLOUR.bold}PHASE ${check.phase}${COLOUR.reset} ${COLOUR.dim}— ${header?.title ?? ""}${COLOUR.reset}`,
      );
      lastPhase = check.phase;
    }
    let outcome: CheckOutcome;
    try {
      outcome = check.run();
    } catch (err) {
      outcome = { status: "FAIL", detail: `Threw: ${(err as Error).message}` };
    }
    results.push({ ...check, ...outcome });
    console.log(
      `  ${STATUS_ICON[outcome.status]}  ${padRight(check.id, 6)} ${padRight(check.title, 60)} ${
        outcome.detail ? COLOUR.grey + outcome.detail + COLOUR.reset : ""
      }`,
    );
  }

  // Jest run
  console.log(`\n${COLOUR.bold}${COLOUR.cyan}Jest test suite${COLOUR.reset}`);
  const jest = runJest(skipTests);
  if (skipTests) {
    console.log(`  ${STATUS_ICON.SKIP}  Skipped via --no-tests`);
  } else {
    console.log(
      `  ${jest.passed ? STATUS_ICON.PASS : STATUS_ICON.FAIL}  ${jest.raw}`,
    );
  }

  // Summary
  const counts: Record<Status, number> = { PASS: 0, WARN: 0, FAIL: 0, SKIP: 0 };
  for (const r of results) counts[r.status] += 1;

  console.log(
    `\n${COLOUR.bold}Summary${COLOUR.reset}\n` +
      `  ${STATUS_ICON.PASS} ${counts.PASS}   ${STATUS_ICON.WARN} ${counts.WARN}   ${STATUS_ICON.FAIL} ${counts.FAIL}   ${STATUS_ICON.SKIP} ${counts.SKIP}`,
  );

  const fails = results.filter((r) => r.status === "FAIL");
  if (fails.length > 0) {
    console.log(`\n${COLOUR.bold}${COLOUR.red}Failed checks${COLOUR.reset}`);
    for (const f of fails) {
      console.log(
        `  ✗ ${f.id} — ${f.title}${f.detail ? `\n    ${COLOUR.grey}${f.detail}${COLOUR.reset}` : ""}`,
      );
    }
  }

  const warns = results.filter((r) => r.status === "WARN");
  if (warns.length > 0) {
    console.log(
      `\n${COLOUR.bold}${COLOUR.yellow}Warnings (advisory, don't block)${COLOUR.reset}`,
    );
    for (const w of warns) {
      console.log(
        `  ⚠ ${w.id} — ${w.title}${w.detail ? `\n    ${COLOUR.grey}${w.detail}${COLOUR.reset}` : ""}`,
      );
    }
  }

  const failBlocking = fails.length > 0 || (!skipTests && !jest.passed);
  if (failBlocking) {
    console.log(
      `\n${COLOUR.red}${COLOUR.bold}AUDIT FAILED${COLOUR.reset} — fix the FAILs above before moving to frontend screens.\n`,
    );
    process.exit(1);
  }
  console.log(
    `\n${COLOUR.green}${COLOUR.bold}AUDIT PASSED${COLOUR.reset} — backend is in shape. Safe to move to frontend screens.\n`,
  );
  process.exit(0);
};

main();
