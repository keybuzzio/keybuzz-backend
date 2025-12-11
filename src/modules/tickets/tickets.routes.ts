/* eslint-disable @typescript-eslint/no-explicit-any */
import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getTicketById, listTicketsForUser } from "./tickets.service";

export function registerTicketRoutes(app: FastifyInstance) {
  app.get(
    "/api/v1/tickets",
    { preHandler: (app as any).authenticate },
    async (request: FastifyRequest) => {
      const tickets = await listTicketsForUser((request as any).user);
      return { data: tickets };
    }
  );

  app.get(
    "/api/v1/tickets/:ticketId",
    { preHandler: (app as any).authenticate },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { ticketId } = request.params as { ticketId: string };
      const ticket = await getTicketById((request as any).user, ticketId);
      if (!ticket) {
        return reply.code(404).send({ error: "Ticket not found" });
      }
      return { data: ticket };
    }
  );
}

