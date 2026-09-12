import { ExpressAdapter } from "@bull-board/express";
import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { allQueues } from "../queues";
import logger from "../config/logger";

/**
 * Configure the Bull Board UI for all eight Project Silk queues.
 *
 * Bull Board provides:
 *   - A web UI at the mount path with per-queue dashboards
 *   - JSON API for the same data (used by its UI; usable programmatically)
 *
 * Mount with: app.use("/admin/queues", isAuthenticated, isAdmin,
 *   requireBullBoardToken, createBullBoardAdapter().getRouter()).
 *
 * Browser access caveat: Bull Board is a web UI, so the browser must
 * present BOTH the JWT (Authorization: Bearer) and the x-bull-board-token
 * header. Easiest approaches:
 *  - Access via the admin SPA which proxies through its own fetch
 *  - Use a header-injection browser extension (ModHeader, Requestly)
 *  - Use curl/HTTPie for direct API queries
 */
export const createBullBoardAdapter = (): ExpressAdapter => {
  const adapter = new ExpressAdapter();
  adapter.setBasePath("/admin/queues");

  // When Redis is unconfigured or degraded, makeQueue() hands back a
  // no-op STUB rather than a real BullMQ Queue (see src/queues). The
  // BullMQ adapter throws on anything that isn't a real Queue, and this
  // runs during boot — an unguarded throw here takes the whole server
  // down before it can listen, turning a degraded dependency into a
  // total outage. Skip what we can't adapt and serve the rest.
  const adapters = [];
  for (const q of Object.values(allQueues)) {
    try {
      adapters.push(new BullMQAdapter(q));
    } catch (err) {
      logger.warn(
        { queue: (q as { name?: string })?.name, err: (err as Error).message },
        "Bull Board: skipping queue that is not a live BullMQ queue (Redis degraded)",
      );
    }
  }

  createBullBoard({ queues: adapters, serverAdapter: adapter });

  return adapter;
};
