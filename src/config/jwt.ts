import fp from "fastify-plugin";
import jwt from "fastify-jwt";
import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { env } from "./env";

export default fp(async function (app: FastifyInstance) {
  app.register(jwt, {
    secret: env.JWT_SECRET,
  });

  app.decorate(
    "authenticate",
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        await request.jwtVerify();
      } catch {
        reply.code(401).send({ error: "Unauthorized" });
      }
    }
  );
});

