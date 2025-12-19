// PH11-06B.7.1: Amazon Polling Health Service with explicit status codes
import { prisma } from '../../lib/db';

export type AmazonPollingStatus = 'OK' | 'WARNING' | 'ERROR' | 'NA';

export interface AmazonPollingHealth {
  status: AmazonPollingStatus;
  message: string;
  oauthConnected: boolean;
  lastRunAt?: string;
  lastSuccessAt?: string;
  lastError?: string;
  reason?: string; // 'success' | 'mock_mode' | 'oauth_not_connected' | 'no_runs' | 'stale' | 'failed'
  jobsLast24h?: { done: number; failed: number };
  isMockMode: boolean;
}

/**
 * Get Amazon Polling health status for a connection
 * PH11-06B.7.1: Explicit status with reason codes, no false positives
 */
export async function getAmazonPollingHealth(connectionId: string): Promise<AmazonPollingHealth> {
  const isMockMode = process.env.AMAZON_USE_MOCK === 'true';

  // 1. Get inbound connection to find tenant
  const inboundConnection = await prisma.inboundConnection.findUnique({
    where: { id: connectionId },
    select: { tenantId: true },
  });

  if (!inboundConnection) {
    return {
      status: 'NA',
      message: 'Inbound connection not found',
      oauthConnected: false,
      reason: 'connection_not_found',
      isMockMode,
    };
  }

  const { tenantId } = inboundConnection;

  // 2. Check MarketplaceConnection AMAZON for this tenant
  const marketplaceConn = await prisma.marketplaceConnection.findFirst({
    where: {
      tenantId,
      type: 'AMAZON',
    },
    select: {
      id: true,
      status: true,
      lastSyncAt: true,
      lastError: true,
    },
  });

  if (!marketplaceConn) {
    return {
      status: 'NA',
      message: 'No Amazon OAuth connection configured',
      oauthConnected: false,
      reason: 'oauth_not_connected',
      isMockMode,
    };
  }

  const oauthConnected = marketplaceConn.status === 'CONNECTED';

  if (!oauthConnected) {
    return {
      status: 'NA',
      message: `OAuth status: ${marketplaceConn.status}`,
      oauthConnected: false,
      reason: 'oauth_not_connected',
      isMockMode,
    };
  }

  // 3. Check recent AMAZON_POLL jobs for this tenant
  const now = new Date();
  const fifteenMinAgo = new Date(now.getTime() - 15 * 60 * 1000);
  const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const recentJobs = await prisma.job.findMany({
    where: {
      tenantId,
      type: 'AMAZON_POLL',
      createdAt: { gte: twentyFourHoursAgo },
    },
    orderBy: { createdAt: 'desc' },
    take: 20,
  });

  // Count done/failed
  const done = recentJobs.filter(j => j.status === 'DONE').length;
  const failed = recentJobs.filter(j => j.status === 'FAILED').length;
  const jobsLast24h = { done, failed };

  // No jobs yet
  if (recentJobs.length === 0) {
    return {
      status: 'WARNING',
      message: 'Polling enabled, no run yet',
      oauthConnected: true,
      reason: 'no_runs',
      lastRunAt: marketplaceConn.lastSyncAt?.toISOString() || undefined,
      isMockMode,
      jobsLast24h,
    };
  }

  // Get last job
  const lastJob = recentJobs[0];
  const lastRunAt = lastJob.updatedAt.toISOString();

  // 4. If in mock mode, always return WARNING (not OK)
  if (isMockMode) {
    return {
      status: 'WARNING',
      message: 'Running in mock mode (not real Amazon data)',
      oauthConnected: true,
      reason: 'mock_mode',
      lastRunAt,
      lastSuccessAt: lastJob.status === 'DONE' ? lastRunAt : undefined,
      isMockMode: true,
      jobsLast24h,
    };
  }

  // 5. Real mode - check actual status
  if (lastJob.status === 'FAILED') {
    return {
      status: 'ERROR',
      message: 'Last poll job failed',
      oauthConnected: true,
      reason: 'failed',
      lastRunAt,
      lastError: lastJob.lastError || marketplaceConn.lastError || undefined,
      isMockMode: false,
      jobsLast24h,
    };
  }

  // Check if recent success (< 15 min)
  const lastJobTime = new Date(lastJob.updatedAt);
  if (lastJob.status === 'DONE' && lastJobTime >= fifteenMinAgo) {
    return {
      status: 'OK',
      message: 'Polling active',
      oauthConnected: true,
      reason: 'success',
      lastRunAt,
      lastSuccessAt: lastRunAt,
      isMockMode: false,
      jobsLast24h,
    };
  }

  // Stale (> 15 min since last success)
  if (lastJob.status === 'DONE' && lastJobTime < fifteenMinAgo) {
    return {
      status: 'WARNING',
      message: 'Last poll > 15min ago',
      oauthConnected: true,
      reason: 'stale',
      lastRunAt,
      lastSuccessAt: lastRunAt,
      isMockMode: false,
      jobsLast24h,
    };
  }

  // Running or pending
  return {
    status: 'WARNING',
    message: `Job status: ${lastJob.status}`,
    oauthConnected: true,
    reason: 'pending',
    lastRunAt: lastJob.createdAt.toISOString(),
    isMockMode,
    jobsLast24h,
  };
}
