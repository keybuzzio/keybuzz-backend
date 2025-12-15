/**
 * PH11-06C: Job worker process
 * 
 * Usage:
 *   node dist/workers/jobsWorker.js       # Run continuously
 *   node dist/workers/jobsWorker.js --once # Run one cycle and exit
 */

/* eslint-disable no-undef */
import { JobType, Prisma } from '@prisma/client';
import { claimNextJob, markJobDone, markJobFailed } from '../modules/jobs/jobs.service';
import { acquireLock, releaseLock, checkAmazonPollRateLimit } from '../modules/rateLimit/rateLimit.service';
// import { processInboundEmail } from '../modules/inbound/inbound.service'; // TODO: implement if needed
import { sendOutboundEmailFromJob } from '../modules/outbound/outboundEmail.service';
import { pollAmazonForTenant } from '../modules/marketplaces/amazon/amazon.poller';

const WORKER_ID = `worker-${process.pid}`;
const POLL_INTERVAL_MS = 5000; // 5 seconds
const RUN_ONCE = process.argv.includes('--once');

/**
 * Process a single job
 */
async function processJob(job: {
  id: string;
  type: JobType;
  tenantId: string;
  payload: Prisma.JsonValue;
}): Promise<void> {
  console.log(`[Worker] Processing job ${job.id} (${job.type})`);

  try {
    // Acquire distributed lock to prevent duplicate processing
    const lockAcquired = await acquireLock(`job:${job.id}`, 300); // 5 min TTL
    if (!lockAcquired) {
      console.warn(`[Worker] Job ${job.id} already locked, skipping`);
      return;
    }

    try {
      // Route to appropriate handler
      switch (job.type) {
        case JobType.INBOUND_EMAIL_PROCESS:
          console.warn(`[Worker] INBOUND_EMAIL_PROCESS not implemented yet`); // TODO
          break;

        case JobType.OUTBOUND_EMAIL_SEND:
          await handleOutboundEmail(job);
          break;

        case JobType.AMAZON_POLL:
          await handleAmazonPoll(job);
          break;

        default:
          throw new Error(`Unknown job type: ${job.type}`);
      }

      // Mark as done
      await markJobDone(job.id);
    } finally {
      // Release lock
      await releaseLock(`job:${job.id}`);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[Worker] Job ${job.id} failed:`, errorMessage);
    await markJobFailed(job.id, errorMessage);
  }
}

/**
 * Handle INBOUND_EMAIL_PROCESS job
 */
async function handleInboundEmail(job: {
  id: string;
  tenantId: string;
  payload: Prisma.JsonValue;
}): Promise<void> {
  console.log('[Worker] INBOUND_EMAIL_PROCESS job received');
  // TODO: Implement inbound email processing
  // This would call the inbound.service.processInboundEmail() function
  throw new Error('INBOUND_EMAIL_PROCESS not yet implemented in worker');
}

/**
 * Handle OUTBOUND_EMAIL_SEND job
 */
async function handleOutboundEmail(job: {
  id: string;
  tenantId: string;
  payload: Prisma.JsonValue;
}): Promise<void> {
  const payload = job.payload as { outboundEmailId?: string };
  const { outboundEmailId } = payload;

  if (!outboundEmailId) {
    throw new Error('Missing outboundEmailId in payload');
  }

  await sendOutboundEmailFromJob(outboundEmailId as string);
}

/**
 * Handle AMAZON_POLL job
 */
async function handleAmazonPoll(job: {
  id: string;
  tenantId: string;
  payload: Prisma.JsonValue;
}): Promise<void> {
  // Check rate limit (1 req/sec per tenant)
  const allowed = await checkAmazonPollRateLimit(job.tenantId);
  if (!allowed) {
    throw new Error(`Rate limit exceeded for Amazon polling (tenant ${job.tenantId})`);
  }

  await pollAmazonForTenant(job.tenantId);
}

/**
 * Main worker loop
 */
async function runWorker(): Promise<void> {
  console.log(`[Worker] Started (${WORKER_ID}), mode: ${RUN_ONCE ? 'once' : 'continuous'}`);

  let running = true;

  // Graceful shutdown
  process.on('SIGTERM', () => {
    console.log('[Worker] SIGTERM received, shutting down gracefully...');
    running = false;
  });

  process.on('SIGINT', () => {
    console.log('[Worker] SIGINT received, shutting down gracefully...');
    running = false;
  });

  while (running) {
    try {
      // Claim next job
      const job = await claimNextJob(WORKER_ID);

      if (job) {
        await processJob(job);
      } else {
        // No job available, wait before next poll
        if (RUN_ONCE) {
          console.log('[Worker] No jobs available, exiting (--once mode)');
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      }
    } catch (error) {
      console.error('[Worker] Error in main loop:', error);
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    if (RUN_ONCE) {
      break;
    }
  }

  console.log('[Worker] Stopped');
  process.exit(0);
}

// Start worker
runWorker().catch((error) => {
  console.error('[Worker] Fatal error:', error);
  process.exit(1);
});

