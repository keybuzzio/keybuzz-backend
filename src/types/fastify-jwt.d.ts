import "@fastify/jwt";
import type { JwtUser } from "./auth";

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: JwtUser;
    user: JwtUser;
  }
}
