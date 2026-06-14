/**
 * Cross-role auth-gate test suite.
 *
 * For every role-checking middleware (`isAdmin`, `isOrgAdmin`,
 * `isTutor`, `isStudent`, `requireTeacherRole`) this test feeds
 * every other role through it and asserts the right pass/403
 * behaviour. The matrix is exhaustive on purpose — a future dev
 * who swaps `isAdmin` for `isOrgAdmin` on a sensitive route would
 * be caught by the per-role expectations below.
 *
 * Why middleware-level rather than HTTP-level
 * ===========================================
 *
 * The gates live in the middleware functions; testing them
 * directly is faster (no app boot, no DB seed) and pinpoints
 * exactly which gate failed. The HTTP layer just chains them.
 *
 * Roles tested
 * ============
 *   - "admin"      Amber super-admin
 *   - "org_admin"  organisation administrator
 *   - "tutor"      legacy marketplace tutor (not necessarily ESOL-approved)
 *   - "student"    learner / ESOL learner
 *
 * What "pass" means
 * =================
 *   The middleware called next() with no error argument.
 *
 * What "block" means
 * ==================
 *   The middleware called next(err) where err.statusCode === 403.
 */

process.env.REFERRAL_JWT_SECRET =
  process.env.REFERRAL_JWT_SECRET ?? "test-secret";

import { Types } from "mongoose";
import {
  isAdmin,
  isOrgAdmin,
  isTutor,
  isStudent,
} from "../middlewares/authMiddleWare";
import { requireTeacherRole } from "../middlewares/teacherMiddleware";
import User from "../models/User";

// ─────────────────────────────────────────────────────────────────────
// Test harness — synth req/res/next, run the middleware, capture
// whether next() was called with an error.
// ─────────────────────────────────────────────────────────────────────

interface Outcome {
  passed: boolean;
  statusCode: number | null;
  message: string | null;
}

const runGate = async (
  middleware: (req: any, res: any, next: any) => unknown,
  req: Record<string, unknown>,
): Promise<Outcome> => {
  return new Promise((resolve) => {
    const next = (err?: unknown) => {
      if (!err)
        return resolve({ passed: true, statusCode: null, message: null });
      const e = err as { statusCode?: number; message?: string };
      resolve({
        passed: false,
        statusCode: e.statusCode ?? null,
        message: e.message ?? null,
      });
    };
    Promise.resolve(middleware(req, {} as unknown, next)).catch((err) => {
      resolve({
        passed: false,
        statusCode: (err as { statusCode?: number }).statusCode ?? 500,
        message: (err as Error).message,
      });
    });
  });
};

type Role = "admin" | "org_admin" | "tutor" | "student";

const reqWith = (role: Role | null, extra: Record<string, unknown> = {}) => ({
  user: role ? { role, id: new Types.ObjectId(), ...extra } : undefined,
});

// ═════════════════════════════════════════════════════════════════════
// Test matrix
// ═════════════════════════════════════════════════════════════════════

describe("auth gates — cross-role matrix", () => {
  // ── isAdmin (Amber super-admin only) ──────────────────────────────
  describe("isAdmin", () => {
    it("admin passes", async () => {
      const r = await runGate(isAdmin, reqWith("admin"));
      expect(r.passed).toBe(true);
    });
    it.each(["org_admin", "tutor", "student"] as const)(
      "%s is 403'd",
      async (role) => {
        const r = await runGate(isAdmin, reqWith(role));
        expect(r.passed).toBe(false);
        expect(r.statusCode).toBe(403);
        expect(r.message).toContain("Admin");
      },
    );
    it("missing user is 403'd (defence-in-depth)", async () => {
      const r = await runGate(isAdmin, reqWith(null));
      expect(r.passed).toBe(false);
      expect(r.statusCode).toBe(403);
    });
  });

  // ── isOrgAdmin (org_admin OR admin) ───────────────────────────────
  describe("isOrgAdmin", () => {
    it.each(["org_admin", "admin"] as const)("%s passes", async (role) => {
      const r = await runGate(isOrgAdmin, reqWith(role));
      expect(r.passed).toBe(true);
    });
    it.each(["tutor", "student"] as const)("%s is 403'd", async (role) => {
      const r = await runGate(isOrgAdmin, reqWith(role));
      expect(r.passed).toBe(false);
      expect(r.statusCode).toBe(403);
      expect(r.message).toContain("Organisation admin");
    });
    it("missing user is 403'd", async () => {
      const r = await runGate(isOrgAdmin, reqWith(null));
      expect(r.passed).toBe(false);
      expect(r.statusCode).toBe(403);
    });
  });

  // ── isTutor (legacy marketplace gate — strict tutor only) ────────
  describe("isTutor", () => {
    it("tutor passes", async () => {
      const r = await runGate(isTutor, reqWith("tutor"));
      expect(r.passed).toBe(true);
    });
    it.each(["admin", "org_admin", "student"] as const)(
      "%s is 403'd",
      async (role) => {
        const r = await runGate(isTutor, reqWith(role));
        expect(r.passed).toBe(false);
        expect(r.statusCode).toBe(403);
        expect(r.message).toContain("Tutor");
      },
    );
    it("missing user is 403'd", async () => {
      const r = await runGate(isTutor, reqWith(null));
      expect(r.passed).toBe(false);
      expect(r.statusCode).toBe(403);
    });
  });

  // ── isStudent (learner only) ──────────────────────────────────────
  describe("isStudent", () => {
    it("student passes", async () => {
      const r = await runGate(isStudent, reqWith("student"));
      expect(r.passed).toBe(true);
    });
    it.each(["admin", "org_admin", "tutor"] as const)(
      "%s is 403'd",
      async (role) => {
        const r = await runGate(isStudent, reqWith(role));
        expect(r.passed).toBe(false);
        expect(r.statusCode).toBe(403);
        expect(r.message).toContain("Student");
      },
    );
    it("missing user is 403'd", async () => {
      const r = await runGate(isStudent, reqWith(null));
      expect(r.passed).toBe(false);
      expect(r.statusCode).toBe(403);
    });
  });

  // ── requireTeacherRole (Final Addendum §9 — tutor + approved + DBS cleared) ─
  //
  // This gate reads `req.user.esol_teacher_approved` +
  // `req.user.dbs_check_status` which are populated by isAuthenticated
  // from the DB on every request. We synth those snake_case fields
  // directly into req.user for the test.
  describe("requireTeacherRole", () => {
    it("approved + dbs cleared tutor passes", async () => {
      const r = await runGate(
        requireTeacherRole,
        reqWith("tutor", {
          esol_teacher_approved: true,
          dbs_check_status: "cleared",
        }),
      );
      expect(r.passed).toBe(true);
    });

    it.each(["admin", "org_admin", "student"] as const)(
      "%s is 403'd even with approval flags set",
      async (role) => {
        const r = await runGate(
          requireTeacherRole,
          reqWith(role, {
            esol_teacher_approved: true,
            dbs_check_status: "cleared",
          }),
        );
        expect(r.passed).toBe(false);
        expect(r.statusCode).toBe(403);
      },
    );

    it("tutor without esol_teacher_approved is 403'd", async () => {
      const r = await runGate(
        requireTeacherRole,
        reqWith("tutor", {
          esol_teacher_approved: false,
          dbs_check_status: "cleared",
        }),
      );
      expect(r.passed).toBe(false);
      expect(r.statusCode).toBe(403);
    });

    it("tutor without dbs cleared is 403'd", async () => {
      const r = await runGate(
        requireTeacherRole,
        reqWith("tutor", {
          esol_teacher_approved: true,
          dbs_check_status: "pending",
        }),
      );
      expect(r.passed).toBe(false);
      expect(r.statusCode).toBe(403);
    });

    it("missing user is rejected", async () => {
      // requireTeacherRole returns 401 (not 403) when the request has
      // no user at all — semantically "you weren't authenticated"
      // rather than "you don't have permission". Acceptable as long
      // as it blocks the call, which is the invariant under test.
      const r = await runGate(requireTeacherRole, reqWith(null));
      expect(r.passed).toBe(false);
      expect([401, 403]).toContain(r.statusCode);
    });
  });
});

// ═════════════════════════════════════════════════════════════════════
// Phase 1-5 route gate spot-check — confirm the SPECIFIC route files
// we added or modified during Phases 1–5 carry the right gates.
//
// Imports each route file's module and reflects the registered
// middleware stack via the router's internal layer stack. Not a
// public API of express, but stable enough for a regression test —
// when express bumps majors and this breaks, we'll see the breakage
// here rather than in production.
// ═════════════════════════════════════════════════════════════════════

describe("phase 1-5 route gate inventory", () => {
  const namesOf = (routerModule: { default: { stack: any[] } }): string[] => {
    const stack = routerModule.default?.stack ?? [];
    const names: string[] = [];
    for (const layer of stack) {
      if (layer?.name === "router" && layer.handle?.stack) {
        for (const inner of layer.handle.stack) {
          if (inner.name) names.push(inner.name);
        }
      }
      if (layer?.name) names.push(layer.name);
      if (Array.isArray(layer?.handle?.stack)) {
        for (const inner of layer.handle.stack) {
          if (inner.name) names.push(inner.name);
        }
      }
    }
    return names;
  };

  it("learnerAuditLog route carries isAuthenticated + isStudent", () => {
    const mod = require("../routes/learnerAuditLog.routes");
    const names = namesOf(mod);
    expect(names).toContain("isAuthenticated");
    expect(names).toContain("isStudent");
  });

  it("orgOnboarding route carries isAuthenticated + isOrgAdmin", () => {
    const mod = require("../routes/orgOnboarding.routes");
    const names = namesOf(mod);
    expect(names).toContain("isAuthenticated");
    expect(names).toContain("isOrgAdmin");
  });

  it("esolMessages route carries isAuthenticated + isStudent + requireOrgContext", () => {
    const mod = require("../routes/esolMessages.routes");
    const names = namesOf(mod);
    expect(names).toContain("isAuthenticated");
    expect(names).toContain("isStudent");
    expect(names).toContain("requireOrgContext");
  });

  it("esolVocab route carries isAuthenticated + isStudent", () => {
    const mod = require("../routes/esolVocab.routes");
    const names = namesOf(mod);
    expect(names).toContain("isAuthenticated");
    expect(names).toContain("isStudent");
  });

  it("orgAdminAuditLog route carries isAuthenticated + isOrgAdmin", () => {
    const mod = require("../routes/orgAdminAuditLog.routes");
    const names = namesOf(mod);
    expect(names).toContain("isAuthenticated");
    expect(names).toContain("isOrgAdmin");
  });

  it("adminOrgs route carries isAuthenticated + isAdmin (covers MIS sync UI)", () => {
    const mod = require("../routes/adminOrgs.routes");
    const names = namesOf(mod);
    expect(names).toContain("isAuthenticated");
    expect(names).toContain("isAdmin");
  });

  it("teacher route carries isAuthenticated + requireTeacherRole + requireTeacherContext", () => {
    const mod = require("../routes/teacher.routes");
    const names = namesOf(mod);
    expect(names).toContain("isAuthenticated");
    expect(names).toContain("requireTeacherRole");
    expect(names).toContain("requireTeacherContext");
  });
});

// Silence Mongoose's "no listener" warning when this suite runs in
// isolation: User is imported above for type-flow but no model query
// happens. Touch it once so the import isn't tree-shaken away by
// future bundlers.
void User;
