import { FastifyInstance } from "fastify";
import { env } from "../../config/env";
import { testDbConnection } from "../../lib/db";

export function registerHealthRoutes(app: FastifyInstance) {
  // Health endpoints should be public (no auth required)
  app.get("/health", { preHandler: [] }, async () => {
    return {
      status: "ok",
      uptime: process.uptime(),
      version: "0.1.0",
      env: env.NODE_ENV,
    };
  });

  app.get("/health/db", { preHandler: [] }, async (_request, reply) => {
    const ok = await testDbConnection();
    if (!ok) {
      return reply.code(500).send({ status: "error" });
    }
    return { status: "ok" };
  });
}
