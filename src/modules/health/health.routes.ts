import { FastifyInstance } from "fastify";
import { env } from "../../config/env";
import { testDbConnection } from "../../lib/db";

export function registerHealthRoutes(app: FastifyInstance) {
  app.get("/health", async () => {
    return {
      status: "ok",
      uptime: process.uptime(),
      version: "0.1.0",
      env: env.NODE_ENV,
    };
  });

  app.get("/health/db", async () => {
    const ok = await testDbConnection();
    return ok ? { status: "ok" } : { status: "error" };
  });
}

