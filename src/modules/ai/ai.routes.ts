// src/modules/ai/ai.routes.ts
import { FastifyInstance } from "fastify";
import { runAiForTicket } from "./aiEngine.service";

export function registerAiTestRoutes(app: FastifyInstance) {
  app.post(
    "/api/v1/ai/test/ticket/:ticketId",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { preHandler: (app as any).authenticate },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (request: any) => {
      const { ticketId } = request.params as { ticketId: string };
      const outcome = await runAiForTicket(ticketId, request.user);
      return { data: outcome };
    }
  );
}

