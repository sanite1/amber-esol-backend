import { ExpressAdapter } from "@bull-board/express";
import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { allQueues } from "../queues";

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

  createBullBoard({
    queues: Object.values(allQueues).map((q) => new BullMQAdapter(q)),
    serverAdapter: adapter,
  });

  return adapter;
};
