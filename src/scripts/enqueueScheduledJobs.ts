/**
 * PH11-06C.2: Enqueue scheduled jobs (Amazon poll, etc.)
 * 
 * Usage: node dist/scripts/enqueueScheduledJobs.js
 */

import { PrismaClient } from '@prisma/client';
import { enqueueJob } from '../modules/jobs/jobs.service';

const prisma = new PrismaClient();

async function enqueueScheduledJobs(): Promise<void> {
  console.log('[Enqueuer] Starting scheduled jobs enqueue...');

  try {
    // 1. Enqueue Amazon poll jobs for all CONNECTED tenants
    console.log('[Enqueuer] Fetching CONNECTED marketplace connections...');
    
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

    console.log(`[Enqueuer] Found ${connections.length} CONNECTED Amazon marketplaces`);

    let enqueuedCount = 0;

    for (const connection of connections) {
      try {
        const jobId = await enqueueJob({
          type: 'AMAZON_POLL' as any, // eslint-disable-line @typescript-eslint/no-explicit-any
          tenantId: connection.tenantId,
          payload: {
            connectionId: connection.id,
          },
        });

        console.log(`[Enqueuer] Enqueued AMAZON_POLL job ${jobId} for tenant ${connection.tenantId}`);
        enqueuedCount++;
      } catch (error) {
        console.error(`[Enqueuer] Error enqueuing job for connection ${connection.id}:`, error);
      }
    }

    console.log(`[Enqueuer] Successfully enqueued ${enqueuedCount} jobs`);

    // 2. Optional: Enqueue outbound retry sweep (future)
    // TODO: Implement outbound retry logic if needed

  } catch (error) {
    console.error('[Enqueuer] Fatal error:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }

  console.log('[Enqueuer] Done');
  process.exit(0);
}

// Run
enqueueScheduledJobs();

