/**
 * PH11-06B.7: Amazon Poll Scheduler (simplified, no Redis)
 * Runs every 5 minutes, enqueues AMAZON_POLL jobs for connected tenants
 */

import { PrismaClient } from '@prisma/client';
import { enqueueJob } from '../modules/jobs/jobs.service';

const prisma = new PrismaClient();

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Check if job was recently enqueued (last 4 min)
 */
async function wasRecentlyEnqueued(tenantId: string): Promise<boolean> {
  const fourMinAgo = new Date(Date.now() - 4 * 60 * 1000);
  
  const recentJob = await prisma.job.findFirst({
    where: {
      tenantId,
      type: 'AMAZON_POLL',
      createdAt: { gte: fourMinAgo },
    },
  });

  return !!recentJob;
}

/**
 * Enqueue AMAZON_POLL jobs for all connected tenants
 */
async function enqueueAmazonPollJobs(): Promise<number> {
  console.log('[Scheduler] Fetching CONNECTED Amazon connections...');

  const connections = await prisma.marketplaceConnection.findMany({
    where: {
      type: 'AMAZON',
      status: 'CONNECTED',
    },
    select: {
      id: true,
      tenantId: true,
    },
  });

  console.log(`[Scheduler] Found ${connections.length} CONNECTED Amazon connections`);

  let enqueuedCount = 0;

  for (const connection of connections) {
    // Skip if recently enqueued (idempotent)
    const recent = await wasRecentlyEnqueued(connection.tenantId);
    if (recent) {
      console.log(`[Scheduler] Skipping ${connection.tenantId} - recently enqueued`);
      continue;
    }

    try {
      const jobId = await enqueueJob({
        type: 'AMAZON_POLL' as any,
        tenantId: connection.tenantId,
        payload: {
          connectionId: connection.id,
          scheduledAt: new Date().toISOString(),
        },
      });

      console.log(`[Scheduler] Enqueued AMAZON_POLL job ${jobId} for tenant ${connection.tenantId}`);
      enqueuedCount++;
    } catch (error) {
      console.error(`[Scheduler] Error enqueuing job for ${connection.tenantId}:`, error);
    }
  }

  return enqueuedCount;
}

/**
 * Run scheduler loop
 */
async function runSchedulerLoop(): Promise<void> {
  console.log(`[Scheduler] Starting Amazon Poll Scheduler (interval: ${POLL_INTERVAL_MS / 1000}s)`);

  while (true) {
    try {
      const enqueuedCount = await enqueueAmazonPollJobs();
      console.log(`[Scheduler] Enqueued ${enqueuedCount} jobs at ${new Date().toISOString()}`);
    } catch (error) {
      console.error('[Scheduler] Error in scheduler loop:', error);
    }

    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

/**
 * Run once
 */
async function runOnce(): Promise<void> {
  try {
    const enqueuedCount = await enqueueAmazonPollJobs();
    console.log(`[Scheduler] Enqueued ${enqueuedCount} jobs`);
  } finally {
    await prisma.$disconnect();
  }
}

// Main
async function main() {
  const isOnceMode = process.argv.includes('--once');

  if (isOnceMode) {
    await runOnce();
    process.exit(0);
  } else {
    await runSchedulerLoop();
  }
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
  console.error('[Scheduler] Fatal error:', err);
  process.exit(1);
});
