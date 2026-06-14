import { Request, Response, NextFunction } from "express";
import { allQueues, QueueName } from "../queues";
import ApiResponse from "../errors/apiResponse";
import ApiError from "../errors/apiError";

/**
 * GET /api/jobs/:queue/:jobId/status
 *
 * Generic BullMQ job status endpoint. Used by clients that have received a
 * 202 Accepted from a long-running route and want to poll for the outcome.
 *
 * Response shape (inside the ApiResponse envelope):
 *   {
 *     jobId: string,
 *     queueName: string,
 *     status: "waiting" | "active" | "completed" | "failed"
 *           | "delayed" | "paused" | "stuck" | "prioritized",
 *     progress: number,    // 0-100; 0 if processor never reported progress
 *     result?: any,        // present only when status === "completed"
 *     error?: string,      // present only when status === "failed"
 *     attempts: number,
 *     created_at: string   // ISO-8601
 *   }
 *
 * Note: BullMQ's getState() returns more states than the brief's four
 * (delayed, paused, stuck, prioritized are also possible). We pass these
 * through verbatim — clients should treat anything not in the canonical
 * four as "still processing".
 */
export const getJobStatus = async (
  req: Request,
  _res: Response,
  next: NextFunction,
) => {
  try {
    const { queue, jobId } = req.params;

    if (!(queue in allQueues)) {
      return next(
        new ApiError(
          404,
          `Unknown queue: ${queue}. Valid queues: ${Object.keys(allQueues).join(", ")}`,
        ),
      );
    }

    const queueObj = allQueues[queue as QueueName];
    const job = await queueObj.getJob(jobId);

    if (!job) {
      return next(
        new ApiError(404, `Job ${jobId} not found in queue ${queue}`),
      );
    }

    const status = await job.getState();
    const rawProgress = job.progress;
    const progress =
      typeof rawProgress === "number"
        ? rawProgress
        : typeof rawProgress === "object" &&
            rawProgress !== null &&
            "percent" in rawProgress
          ? Number((rawProgress as { percent: number }).percent) || 0
          : 0;

    const payload: Record<string, unknown> = {
      jobId: job.id,
      queueName: queue,
      status,
      progress,
      attempts: job.attemptsMade,
      created_at: new Date(job.timestamp).toISOString(),
    };

    if (status === "completed") {
      payload.result = job.returnvalue;
    }
    if (status === "failed") {
      payload.error = job.failedReason || "Unknown error";
    }

    return _res.status(200).json(new ApiResponse(200, "Job status", payload));
  } catch (err) {
    next(err);
  }
};
