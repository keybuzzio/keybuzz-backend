/**
 * PH11-06C: Jobs Worker - processes all job types
 * PH11-06B.9: Added AMAZON_SEND_REPLY handler
 */

import { JobType, JobStatus, PrismaClient } from "@prisma/client";
import { claimNextJob, markJobDone, markJobFailed } from "../modules/jobs/jobs.service";
import { pollAmazonForTenant } from "../modules/marketplaces/amazon/amazon.poller";
import { processAmazonSendReply } from "./amazonSendReplyWorker";

const prisma = new PrismaClient();
const WORKER_ID = `worker-${process.pid}`;
const POLL_INTERVAL_MS = 2000;

/**
 * Process a single job based on type
 */
async function processJob(job: {
  id: string;
  type: JobType;
  tenantId: string;
  payload: any;
}): Promise<void> {
  console.log(`[JobsWorker] Processing ${job.type} for tenant ${job.tenantId}`);

  switch (job.type) {
    case "AMAZON_POLL":
      await pollAmazonForTenant(job.tenantId);
      break;

    case "AMAZON_SEND_REPLY":
      const result = await processAmazonSendReply(job.id, job.tenantId, job.payload);
      if (!result.success) {
        throw new Error(result.error || "Send reply failed");
      }
      break;

    case "INBOUND_EMAIL_PROCESS":
      // TODO: Implement inbound email processing
      console.log(`[JobsWorker] INBOUND_EMAIL_PROCESS not implemented`);
      break;

    case "OUTBOUND_EMAIL_SEND":
      // TODO: Implement outbound email sending
      console.log(`[JobsWorker] OUTBOUND_EMAIL_SEND not implemented`);
      break;

    default:
      console.warn(`[JobsWorker] Unknown job type: ${job.type}`);
  }
}

/**
 * Main worker loop
 */
async function runWorker(): Promise<void> {
  console.log(`[JobsWorker] Starting worker ${WORKER_ID}`);

  while (true) {
    try {
      const job = await claimNextJob(WORKER_ID);

      if (job) {
        try {
          await processJob(job);
          await markJobDone(job.id);
          console.log(`[JobsWorker] Job ${job.id} completed`);
        } catch (error) {
          console.error(`[JobsWorker] Job ${job.id} failed:`, error);
          await markJobFailed(job.id, (error as Error).message);
        }
      }

      // Wait before next poll
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    } catch (error) {
      console.error("[JobsWorker] Error in worker loop:", error);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}

// Start worker if run directly
if (require.main === module) {
  runWorker().catch(console.error);
}

export { processJob, runWorker };
