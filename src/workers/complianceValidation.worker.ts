import { createBaseWorker } from "./createBaseWorker";
import { processComplianceValidation } from "../services/queueProcessors";
import type { ComplianceValidationJob } from "../queues";

/** Worker for the `compliance-validation` queue (high priority — gates MIS push). */
export const createComplianceValidationWorker = () =>
  createBaseWorker<ComplianceValidationJob>({
    queueName: "compliance-validation",
    processor: processComplianceValidation,
    concurrency: 5,
  });
