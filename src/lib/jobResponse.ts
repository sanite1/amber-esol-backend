import { Response } from "express";
import { Job } from "bullmq";
import { QueueName } from "../queues";

/**
 * Helper for long-running route handlers that enqueue a BullMQ job and
 * return immediately. Standardises the 202 Accepted response shape so
 * clients can poll for status via the URL we return.
 *
 * Usage in a future route handler:
 *
 *   const job = await ilrExportQueue.add("export", payload);
 *   return respondWithAcceptedJob(res, job, "ilr-export");
 *
 * The client receives:
 *   HTTP 202 Accepted
 *   {
 *     statusCode: 202,
 *     message: "Job enqueued",
 *     data: {
 *       jobId: "42",
 *       queueName: "ilr-export",
 *       statusUrl: "/api/jobs/ilr-export/42/status"
 *     }
 *   }
 *
 * — and can then poll statusUrl until status === "completed" or "failed".
 */
export const respondWithAcceptedJob = (
  res: Response,
  job: Job,
  queueName: QueueName,
  message: string = "Job enqueued",
): Response => {
  return res.status(202).json({
    statusCode: 202,
    message,
    data: {
      jobId: String(job.id),
      queueName,
      statusUrl: `/api/jobs/${queueName}/${job.id}/status`,
    },
  });
};
