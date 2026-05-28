import { createBaseWorker } from "./createBaseWorker";
import { processRarpaEvidence } from "../services/queueProcessors";
import type { RarpaEvidenceJob } from "../queues";

/** Worker for the `rarpa-evidence` queue (standard priority). */
export const createRarpaEvidenceWorker = () =>
  createBaseWorker<RarpaEvidenceJob>({
    queueName: "rarpa-evidence",
    processor: processRarpaEvidence,
    concurrency: 5,
  });
