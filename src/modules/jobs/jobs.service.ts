/**
 * PH11-06C: Job queue service (DB-backed)
 */

import { PrismaClient, JobType, JobStatus, Prisma } from '@prisma/client';

const prisma = new PrismaClient();

interface EnqueueJobParams {
  type: JobType;
  tenantId: string;
  payload: Prisma.JsonValue;
  runAt?: Date;
  maxAttempts?: number;
}

/**
 * Enqueue a new job
 */
export async function enqueueJob(params: EnqueueJobParams): Promise<string> {
  const { type, tenantId, payload, runAt, maxAttempts = 8 } = params;

  const job = await prisma.job.create({
    data: {
      type,
      tenantId,
      payload: (payload as any), // eslint-disable-line @typescript-eslint/no-explicit-any
      nextRunAt: runAt || new Date(),
      maxAttempts,
      status: JobStatus.PENDING,
    },
  });

  console.log(`[Jobs] Enqueued job ${job.id} (${type}) for tenant ${tenantId}`);
  return job.id;
}

/**
 * Claim next available job (atomic via SELECT FOR UPDATE SKIP LOCKED)
 * Returns null if no job available
 */
export async function claimNextJob(workerId: string): Promise<{
  id: string;
  type: JobType;
  tenantId: string;
  payload: Prisma.JsonValue;
} | null> {
  const now = new Date();

  // Find next job to process
  const jobs = await prisma.$queryRaw<Array<{
    id: string;
    type: JobType;
    tenantId: string;
    payload: Prisma.JsonValue;
  }>>`
    SELECT id, type, "tenantId", payload
    FROM "Job"
    WHERE status IN ('PENDING', 'RETRY')
      AND "nextRunAt" <= ${now}
    ORDER BY "nextRunAt" ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  `;

  if (!jobs || jobs.length === 0) {
    return null;
  }

  const job = jobs[0];

  // Mark as RUNNING
  await prisma.job.update({
    where: { id: job.id },
    data: {
      status: JobStatus.RUNNING,
      lockedAt: now,
      lockedBy: workerId,
    },
  });

  console.log(`[Jobs] Claimed job ${job.id} (${job.type}) by worker ${workerId}`);
  
  return {
    id: job.id,
    type: job.type,
    tenantId: job.tenantId,
    payload: job.payload,
  };
}

/**
 * Mark job as done
 */
export async function markJobDone(jobId: string): Promise<void> {
  await prisma.job.update({
    where: { id: jobId },
    data: {
      status: JobStatus.DONE,
      lastError: null,
      lockedAt: null,
      lockedBy: null,
    },
  });

  console.log(`[Jobs] Job ${jobId} marked as DONE`);
}

/**
 * Mark job as failed, with retry logic
 */
export async function markJobFailed(jobId: string, error: string): Promise<void> {
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    select: { attempts: true, maxAttempts: true },
  });

  if (!job) {
    console.error(`[Jobs] Job ${jobId} not found`);
    return;
  }

  const newAttempts = job.attempts + 1;
  const shouldRetry = newAttempts < job.maxAttempts;

  if (shouldRetry) {
    // Exponential backoff: 2^attempts seconds
    const backoffSeconds = Math.pow(2, newAttempts);
    const nextRunAt = new Date(Date.now() + backoffSeconds * 1000);

    await prisma.job.update({
      where: { id: jobId },
      data: {
        status: JobStatus.RETRY,
        attempts: newAttempts,
        lastError: error.substring(0, 10000), // Limit error size
        nextRunAt,
        lockedAt: null,
        lockedBy: null,
      },
    });

    console.log(`[Jobs] Job ${jobId} failed (attempt ${newAttempts}/${job.maxAttempts}), will retry at ${nextRunAt.toISOString()}`);
  } else {
    await prisma.job.update({
      where: { id: jobId },
      data: {
        status: JobStatus.FAILED,
        attempts: newAttempts,
        lastError: error.substring(0, 10000),
        lockedAt: null,
        lockedBy: null,
      },
    });

    console.error(`[Jobs] Job ${jobId} permanently FAILED after ${newAttempts} attempts`);
  }
}

/**
 * Get job stats (for ops endpoint)
 */
export async function getJobStats(): Promise<Record<string, unknown>> {
  const stats = await prisma.job.groupBy({
    by: ['status', 'type'],
    _count: true,
  });

  return {
    byStatusAndType: stats,
    total: stats.reduce((sum, s) => sum + s._count, 0),
  };
}

/**
 * Get recent failed jobs (for ops endpoint)
 */
export async function getRecentFailedJobs(limit = 20): Promise<Array<{
  id: string;
  type: JobType;
  tenantId: string;
  attempts: number;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}>> {
  return prisma.job.findMany({
    where: { status: JobStatus.FAILED },
    orderBy: { updatedAt: 'desc' },
    take: limit,
    select: {
      id: true,
      type: true,
      tenantId: true,
      attempts: true,
      lastError: true,
      createdAt: true,
      updatedAt: true,
    },
  });
}


/**
 * Mark job for retry with exponential backoff
 */
export async function markJobRetry(jobId: string, error: string): Promise<void> {
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) return;

  const nextAttempt = job.attempts + 1;
  const backoffSeconds = Math.min(Math.pow(2, nextAttempt) * 10, 3600);
  const nextRunAt = new Date(Date.now() + backoffSeconds * 1000);

  await prisma.job.update({
    where: { id: jobId },
    data: {
      status: JobStatus.RETRY,
      attempts: nextAttempt,
      nextRunAt,
      lastError: error,
      lockedAt: null,
      lockedBy: null,
    },
  });

  console.log("[Jobs] Job " + jobId + " scheduled for retry at " + nextRunAt.toISOString());
}
