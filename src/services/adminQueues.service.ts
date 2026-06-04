/**
 * Admin queues service — Final Addendum §1.
 *
 * Two flows:
 *
 *   GET /api/admin/queues/summary   getQueueSummaryService
 *     Per-queue job counts via BullMQ Queue.getJobCounts(). Powers the
 *     "active / failed / delayed per queue" header on the dashboard
 *     Queues page so admins can spot stuck queues without opening
 *     Bull Board.
 *
 *   GET /api/admin/queues/link      getBullBoardLinkService
 *     Returns the URL the dashboard's "Open Bull Board" button opens
 *     in a new tab. The URL carries the BULL_BOARD_TOKEN as a query
 *     param — the only path that survives the browser's "no custom
 *     headers on top-level navigation" constraint. See
 *     middlewares/bullBoardToken.ts for the trade-offs.
 *
 * Concurrency: getJobCounts() per queue runs in parallel via
 * Promise.all — eight Redis round-trips in flight at once, which the
 * single ioredis connection handles comfortably.
 */

import ApiError from "../errors/apiError";
import ApiResponse from "../errors/apiResponse";
import { allQueues, QueueName } from "../queues";
import logger from "../config/logger";

// The five BullMQ states we surface. "paused" intentionally omitted —
// we don't pause queues in production and a paused-zero row is noise.
const COUNT_STATES = [
  "waiting",
  "active",
  "completed",
  "failed",
  "delayed",
] as const;

type CountState = (typeof COUNT_STATES)[number];

export interface QueueCounts {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
}

export interface QueueSummaryRow {
  name: QueueName;
  counts: QueueCounts;
  /** Convenience flag — true when failed > 0 or waiting + active is high. */
  needs_attention: boolean;
}

export interface QueueSummaryResponse {
  generated_at: string;
  queues: QueueSummaryRow[];
  totals: QueueCounts;
}

/**
 * Heuristic: a queue "needs attention" when there are any failed
 * jobs or the backlog (waiting + delayed) exceeds 50. Surfaces at
 * the row level for highlighting in the UI without a separate alerts
 * pipeline.
 */
const needsAttention = (c: QueueCounts): boolean =>
  c.failed > 0 || c.waiting + c.delayed > 50;

export const getQueueSummaryService = async (): Promise<ApiResponse> => {
  const entries = Object.entries(allQueues) as Array<
    [QueueName, (typeof allQueues)[QueueName]]
  >;

  const rows = await Promise.all(
    entries.map(async ([name, queue]) => {
      try {
        // BullMQ types `getJobCounts(...states)` to return a record keyed
        // by the state names. The cast lets us index into it cleanly.
        const raw = (await queue.getJobCounts(...COUNT_STATES)) as Record<
          CountState,
          number
        >;
        const counts: QueueCounts = {
          waiting: raw.waiting ?? 0,
          active: raw.active ?? 0,
          completed: raw.completed ?? 0,
          failed: raw.failed ?? 0,
          delayed: raw.delayed ?? 0,
        };
        return {
          name,
          counts,
          needs_attention: needsAttention(counts),
        };
      } catch (err) {
        // A single queue failing to report counts (e.g. Redis blip)
        // mustn't tank the whole endpoint. Log and return zeros so
        // the UI shows the queue exists but didn't respond.
        logger.error(
          { err: (err as Error).message, queue: name },
          "getQueueSummary: queue counts failed",
        );
        return {
          name,
          counts: {
            waiting: 0,
            active: 0,
            completed: 0,
            failed: 0,
            delayed: 0,
          },
          needs_attention: false,
        };
      }
    }),
  );

  // Totals — sum each state across every queue.
  const totals: QueueCounts = {
    waiting: 0,
    active: 0,
    completed: 0,
    failed: 0,
    delayed: 0,
  };
  for (const row of rows) {
    totals.waiting += row.counts.waiting;
    totals.active += row.counts.active;
    totals.completed += row.counts.completed;
    totals.failed += row.counts.failed;
    totals.delayed += row.counts.delayed;
  }

  const payload: QueueSummaryResponse = {
    generated_at: new Date().toISOString(),
    queues: rows,
    totals,
  };

  return new ApiResponse(200, "Queue summary", payload);
};

// ─────────────────────────────────────────────────────────────────────
// GET /api/admin/queues/link
// ─────────────────────────────────────────────────────────────────────

export interface BullBoardLinkResponse {
  /** Absolute or path-relative URL with ?token= attached. */
  url: string;
  /**
   * Caveats the frontend can surface in the UI tooltip — kept short
   * so the operator knows what they're clicking.
   */
  notes: string;
}

/**
 * Returns the URL the dashboard's "Open Bull Board" button opens.
 *
 * The token is read from BULL_BOARD_TOKEN env. Refusing here when the
 * env var is missing prevents the page from rendering a button that
 * 500s when clicked.
 *
 * The URL is server-relative (`/admin/queues?token=…`) — the browser
 * resolves it against the current origin, so it works in dev (where
 * the API and the dashboard share localhost) and in prod (where they
 * may or may not).
 */
export const getBullBoardLinkService = async (): Promise<ApiResponse> => {
  const token = process.env.BULL_BOARD_TOKEN;
  if (!token) {
    throw new ApiError(
      500,
      "BULL_BOARD_TOKEN is not configured on the server",
    );
  }

  const payload: BullBoardLinkResponse = {
    url: `/admin/queues?token=${encodeURIComponent(token)}`,
    notes:
      "Open in a new tab. The token appears once in the URL bar for this navigation; Bull Board's own subsequent requests use cookies.",
  };

  return new ApiResponse(200, "Bull Board link", payload);
};
