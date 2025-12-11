/* eslint-disable @typescript-eslint/no-explicit-any */
import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AuthUser } from "../auth/auth.types";
import { addMessageToTicket, listMessagesForTicket } from "./messages.service";

export function registerTicketMessageRoutes(app: FastifyInstance) {
  app.get(
    "/api/v1/tickets/:ticketId/messages",
    { preHandler: (app as any).authenticate },
    async (request: FastifyRequest) => {
      const { ticketId } = request.params as { ticketId: string };
      const user = (request as any).user as AuthUser;
      const messages = await listMessagesForTicket(user, ticketId);
      return { data: messages };
    }
  );

  app.post(
    "/api/v1/tickets/:ticketId/messages",
    { preHandler: (app as any).authenticate },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { ticketId } = request.params as { ticketId: string };
      const { body, isInternal } = request.body as { body: string; isInternal?: boolean };

      if (!body) {
        return reply.code(400).send({ error: "Message body is required" });
      }

      try {
        const user = (request as any).user as AuthUser;
        const message = await addMessageToTicket(
          user,
          ticketId,
          body,
          Boolean(isInternal)
        );
        return { data: message };
      } catch (err: any) {
        if (err.message === "Ticket not found") {
          return reply.code(404).send({ error: "Ticket not found" });
        }
        if (err.message === "Forbidden") {
          return reply.code(403).send({ error: "Forbidden" });
        }
        return reply.code(500).send({ error: "Unable to add message" });
      }
    }
  );
}

