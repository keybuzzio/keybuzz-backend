/**
 * PH11-06C: Internal ops endpoints for job monitoring
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getJobStats, getRecentFailedJobs } from '../jobs/jobs.service';

/**
 * Check ops authentication
 */
async function checkOpsAuth(request: FastifyRequest, reply: FastifyReply) {
  const opsKey = process.env.KEYBUZZ_INTERNAL_OPS_KEY;

  if (!opsKey) {
    console.warn('[Ops] KEYBUZZ_INTERNAL_OPS_KEY not configured');
    return reply.code(500).send({ error: 'Internal ops not configured' });
  }

  const authHeader = request.headers.authorization;
  const providedKey = authHeader?.replace('Bearer ', '');

  if (providedKey !== opsKey) {
    return reply.code(401).send({ error: 'Unauthorized' });
  }
}

/**
 * Register ops routes
 */
export async function registerOpsRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * GET /internal/ops/jobs/stats
   * Returns job statistics by status and type
   */
  fastify.get('/internal/ops/jobs/stats', { preHandler: [checkOpsAuth] }, async (request, reply) => {
    try {
      const stats = await getJobStats();
      return reply.code(200).send(stats);
    } catch (error) {
      console.error('[Ops] Error fetching job stats:', error);
      return reply.code(500).send({ 
        error: 'Internal server error',
        message: error instanceof Error ? error.message : String(error)
      });
    }
  });

  /**
   * GET /internal/ops/jobs/failed
   * Returns recent failed jobs (last 20 by default)
   */
  fastify.get<{
    Querystring: { limit?: string };
  }>('/internal/ops/jobs/failed', { preHandler: [checkOpsAuth] }, async (request, reply) => {
    try {
      const limit = request.query.limit ? parseInt(request.query.limit, 10) : 20;
      const failedJobs = await getRecentFailedJobs(limit);
      
      return reply.code(200).send({
        count: failedJobs.length,
        jobs: failedJobs,
      });
    } catch (error) {
      console.error('[Ops] Error fetching failed jobs:', error);
      return reply.code(500).send({ 
        error: 'Internal server error',
        message: error instanceof Error ? error.message : String(error)
      });
    }
  });
}
