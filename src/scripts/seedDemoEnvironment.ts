/**
 * Demo-environment seed script — brief Function 16 Todo 17.1.
 *
 * Real implementation lands with Todo 17.1 (Hillview Adult Learning
 * fixture: org, org-admin, 30 learners, AISession records, vocab
 * ledger, safeguarding alerts, level changes, teacher reviews,
 * audit log).
 *
 * This file ships the FUNCTION SIGNATURE now so the daily reset
 * cron (Function 16 reset endpoint) can import it without breaking
 * the build. The stub body returns a structured "not yet
 * implemented" result so the cron's success/failure email is
 * accurate — when the real seed lands the cron picks it up with no
 * other changes.
 *
 * Invocation:
 *   - Direct CLI run via `npm run seed:demo` (Todo 17.1 also adds
 *     the package script).
 *   - Programmatic call from the daily reset cron.
 *
 * Hard refusal: this function MUST fail closed when DEMO_MODE !==
 * "true". The guard is duplicated at every entry point (the cron,
 * the CLI runner) — defence in depth against ever, ever writing
 * fixtures into the production cluster.
 */

import logger from "../config/logger";
import { IS_DEMO_MODE } from "../config/demoMode";

export interface DemoSeedResult {
  ok: boolean;
  /** When ok is true: counts of each seeded collection. */
  counts: Record<string, number>;
  /** When ok is false: the reason (surfaced in the cron email). */
  reason?: string;
  /** Always set — useful for the cron email's "completed at" line. */
  completed_at: string;
}

/**
 * Seed the demo Mongo cluster with the Hillview fixture.
 *
 * Pre-conditions:
 *   - DEMO_MODE=true on the running process (else throws).
 *   - The caller has already DROPPED the demo cluster (the reset
 *     cron does this before calling the seed). The seed itself
 *     does not drop — it assumes a clean slate.
 *
 * Returns a result envelope so the cron can render an email
 * without rethrowing.
 */
export const seedDemoEnvironment = async (): Promise<DemoSeedResult> => {
  if (!IS_DEMO_MODE) {
    throw new Error(
      "seedDemoEnvironment refused: DEMO_MODE is not enabled on this process. " +
        "Seeding outside a demo deployment would write fixtures into a real cluster.",
    );
  }

  // ── STUB BODY — Todo 17.1 replaces this block. ───────────────────
  // Returning `ok: false` with a clear reason keeps the cron's
  // email truthful: "the reset ran, the drop happened, but no
  // fixture was loaded yet because Todo 17.1 hasn't shipped."
  logger.warn(
    "seedDemoEnvironment: STUB. Todo 17.1 will seed the Hillview fixture.",
  );
  return {
    ok: false,
    counts: {},
    reason:
      "Demo seed not yet implemented — Todo 17.1 ships the Hillview fixture.",
    completed_at: new Date().toISOString(),
  };
};
