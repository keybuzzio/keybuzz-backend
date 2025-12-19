/**
 * PH11-06C + PH11-06B.7: Jobs Worker
 */

import { PrismaClient, JobStatus, JobType } from '@prisma/client';
import { claimNextJob, markJobDone, markJobFailed, markJobRetry } from '../modules/jobs/jobs.service';
import { pollAmazonForTenant } from '../modules/marketplaces/amazon/amazon.poller';

const prisma = new PrismaClient();

const WORKER_ID = `worker-${process.pid}-${Date.now()}`;
const POLL_INTERVAL_MS = 2000;

/**
 * Process AMAZON_POLL job
 */
async function processAmazonPoll(jobId: string, tenantId: string, payload: any): Promise<void> {
  console.log(`[Worker] Processing AMAZON_POLL for tenant ${tenantId}`);

  const connection = await prisma.marketplaceConnection.findFirst({
    where: {
      tenantId,
      type: 'AMAZON',
      status: 'CONNECTED',
    },
  });

  if (!connection) {
    console.log(`[Worker] No CONNECTED Amazon connection for tenant ${tenantId}`);
    return;
  }

  await pollAmazonForTenant(tenantId);
}

/**
 * Process a single job
 */
async function processJob(job: { id: string; type: JobType; tenantId: string; payload: any }): Promise<void> {
  console.log(`[Worker] Processing job ${job.id} (${job.type}) for tenant ${job.tenantId}`);

  try {
    switch (job.type) {
      case 'AMAZON_POLL':
        await processAmazonPoll(job.id, job.tenantId, job.payload);
        break;

      case 'OUTBOUND_EMAIL_SEND':
        console.log(`[Worker] OUTBOUND_EMAIL_SEND - processing...`);
        // Handled elsewhere or skip
        break;

      case 'INBOUND_EMAIL_PROCESS':
        console.log(`[Worker] INBOUND_EMAIL_PROCESS - not implemented`);
        break;

      default:
        console.warn(`[Worker] Unknown job type: ${job.type}`);
    }

    await markJobDone(job.id);
    console.log(`[Worker] Job ${job.id} completed successfully`);

  } catch (error: any) {
    console.error(`[Worker] Job ${job.id} failed:`, error);
    
    const jobRecord = await prisma.job.findUnique({ where: { id: job.id } });
    
    if (jobRecord && jobRecord.attempts < jobRecord.maxAttempts) {
      await markJobRetry(job.id, error.message || 'Unknown error');
    } else {
      await markJobFailed(job.id, error.message || 'Unknown error');
    }
  }
}

/**
 * Worker loop
 */
async function workerLoop(): Promise<void> {
  console.log(`[Worker] Starting jobs worker (ID: ${WORKER_ID})`);

  while (true) {
    try {
      const job = await claimNextJob(WORKER_ID);

      if (job) {
        await processJob(job);
      } else {
        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
      }
    } catch (error) {
      console.error('[Worker] Error in worker loop:', error);
      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS * 2));
    }
  }
}

async function main() {
  console.log('[Worker] Jobs Worker starting...');
  await workerLoop();
}

process.on('SIGTERM', async () => {
  await prisma.$disconnect();
  process.exit(0);
});

process.on('SIGINT', async () => {
  await prisma.$disconnect();
  process.exit(0);
});

main().catch(err => {
  console.error('[Worker] Fatal error:', err);
  process.exit(1);
});
