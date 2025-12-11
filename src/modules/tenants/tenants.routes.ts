import { FastifyInstance } from "fastify";
import { getTenants } from "./tenants.service";

export function registerTenantRoutes(app: FastifyInstance) {
  app.get("/api/v1/tenants", async () => {
    const tenants = await getTenants();
    return { data: tenants };
  });
}

