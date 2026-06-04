/**
 * Daily demo-environment reset — brief Function 16 cron.
 *
 * The Vercel cron (`/api/cron/reset-demo-environment`, 03:00 UTC
 * daily) calls this service. The job is:
 *
 *   1. Hard-guard on DEMO_MODE === true. NEVER touch production.
 *   2. Drop every collection in the connected Mongo database.
 *   3. Invoke the demo-seed script (Todo 17.1).
 *   4. Email Joey with the outcome (success or failure).
 *
 * Failure handling
 *
 *   - Any step throw is captured and surfaced in the failure email
 *     so Joey isn't troubleshooting blind.
 *   - The function never re-throws to the cron — the cron handler
 *     reads the result envelope and chooses 200 vs 500 based on
 *     `ok`. This keeps Vercel's cron retry behaviour deterministic.
 *
 * Why drop-then-seed rather than drop-then-restore-from-snapshot?
 *
 *   The seed script is the canonical source of demo fixtures. A
 *   snapshot approach would diverge from the script over time and
 *   re-introduce the "but the demo deployment looks different"
 *   class of bugs Function 16 exists to eliminate. The seed is
 *   small and idempotent — running it every morning is cheap.
 */

import mongoose from "mongoose";
import transporter from "./nodemailer/nodemailer";
import logger from "../config/logger";
import { IS_DEMO_MODE } from "../config/demoMode";
import { seedDemoEnvironment, DemoSeedResult } from "../scripts/seedDemoEnvironment";

export interface DemoResetResult {
  ok: boolean;
  reason?: string;
  /** Collections that were dropped, in deletion order. */
  dropped: string[];
  /** Seed result envelope, when the seed ran. */
  seed?: DemoSeedResult;
  started_at: string;
  completed_at: string;
}

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

/**
 * Drop every collection in the currently-connected database.
 *
 * We list collections first (then drop) rather than calling
 * `db.dropDatabase()` because dropping the database invalidates
 * indexes and Mongoose-cached metadata in ways that occasionally
 * surface as "ns not found" errors on the next read. Drop-per-
 * collection leaves Mongoose's connection state intact and is the
 * idiomatic test-cleanup pattern.
 *
 * System collections (`system.*`) are explicitly excluded —
 * dropping them is a no-op on managed Mongo and can throw on Atlas.
 */
const dropAllCollections = async (): Promise<string[]> => {
  const db = mongoose.connection.db;
  if (!db) {
    throw new Error(
      "dropAllCollections: mongoose connection has no `db` — was connectDb() awaited?",
    );
  }

  const collections = await db.listCollections().toArray();
  const dropped: string[] = [];

  for (const info of collections) {
    if (info.name.startsWith("system.")) continue;
    try {
      await db.dropCollection(info.name);
      dropped.push(info.name);
    } catch (err) {
      // 26 = NamespaceNotFound. A racing concurrent drop is fine —
      // we wanted the collection gone, and it is.
      const code = (err as { code?: number }).code;
      if (code === 26) {
        dropped.push(info.name);
        continue;
      }
      throw err;
    }
  }

  return dropped;
};

// ─────────────────────────────────────────────────────────────────────
// Reset email to Joey
// ─────────────────────────────────────────────────────────────────────

const buildEmailHtml = (result: DemoResetResult): string => {
  const seedLines = result.seed
    ? Object.entries(result.seed.counts ?? {})
        .map(([k, v]) => `<li><strong>${k}</strong>: ${v}</li>`)
        .join("")
    : "";

  return `
    <p>The daily Project Silk demo reset ran at ${result.started_at}.</p>
    <p><strong>Status:</strong> ${result.ok ? "✅ Success" : "❌ Failed"}</p>
    ${result.reason ? `<p><strong>Reason:</strong> ${result.reason}</p>` : ""}
    <p><strong>Dropped collections (${result.dropped.length}):</strong></p>
    <p>${result.dropped.length === 0 ? "(none)" : result.dropped.join(", ")}</p>
    ${
      result.seed && result.seed.counts && Object.keys(result.seed.counts).length > 0
        ? `<p><strong>Seeded:</strong></p><ul>${seedLines}</ul>`
        : ""
    }
    ${
      result.seed && !result.seed.ok && result.seed.reason
        ? `<p><strong>Seed note:</strong> ${result.seed.reason}</p>`
        : ""
    }
    <p style="color:#666;font-size:12px">Completed at ${result.completed_at}.</p>
  `;
};

const sendResetEmail = async (result: DemoResetResult): Promise<void> => {
  const recipient = process.env.JOEY_EMAIL;
  if (!recipient) {
    logger.warn(
      { ok: result.ok },
      "demoReset: JOEY_EMAIL not configured — skipping outcome email",
    );
    return;
  }

  const subject = result.ok
    ? "Demo environment reset — success"
    : "Demo environment reset — FAILED";

  try {
    await transporter.sendMail({
      from: process.env.AUTH_EMAIL,
      to: recipient,
      subject,
      html: buildEmailHtml(result),
    });
    logger.info({ recipient, ok: result.ok }, "demoReset: outcome email sent");
  } catch (err) {
    // Best-effort — the reset itself already completed; an email
    // failure shouldn't change its outcome status.
    logger.error(
      { err: (err as Error).message },
      "demoReset: outcome email failed to send",
    );
  }
};

// ─────────────────────────────────────────────────────────────────────
// Top-level entry — runDemoReset()
// ─────────────────────────────────────────────────────────────────────

/**
 * Run the full reset pipeline. Always returns a result envelope;
 * never throws to the caller.
 */
export const runDemoReset = async (): Promise<DemoResetResult> => {
  const started_at = new Date().toISOString();

  // ── 1. The hard guard. ────────────────────────────────────────
  // Belt + braces: the cron route also checks this; the service
  // checks again so a future caller (CLI test, manual debug) can
  // never accidentally hit production.
  if (!IS_DEMO_MODE) {
    const result: DemoResetResult = {
      ok: false,
      reason:
        "DEMO_MODE is not enabled on this process. Refused to drop any data.",
      dropped: [],
      started_at,
      completed_at: new Date().toISOString(),
    };
    logger.error(result.reason!);
    // No email — if we're not in demo mode this was probably called
    // by accident; emailing Joey "we refused to delete production"
    // is alarming for no reason. Logger captures it.
    return result;
  }

  // ── 2. Drop all collections. ──────────────────────────────────
  let dropped: string[] = [];
  try {
    dropped = await dropAllCollections();
    logger.info({ count: dropped.length, dropped }, "demoReset: collections dropped");
  } catch (err) {
    const result: DemoResetResult = {
      ok: false,
      reason: `Failed to drop collections: ${(err as Error).message}`,
      dropped,
      started_at,
      completed_at: new Date().toISOString(),
    };
    await sendResetEmail(result);
    return result;
  }

  // ── 3. Seed. ──────────────────────────────────────────────────
  let seed: DemoSeedResult;
  try {
    seed = await seedDemoEnvironment();
  } catch (err) {
    const result: DemoResetResult = {
      ok: false,
      reason: `Seed threw: ${(err as Error).message}`,
      dropped,
      started_at,
      completed_at: new Date().toISOString(),
    };
    await sendResetEmail(result);
    return result;
  }

  const result: DemoResetResult = {
    ok: seed.ok,
    reason: seed.ok ? undefined : seed.reason,
    dropped,
    seed,
    started_at,
    completed_at: new Date().toISOString(),
  };

  // ── 4. Email Joey. ────────────────────────────────────────────
  await sendResetEmail(result);
  return result;
};
