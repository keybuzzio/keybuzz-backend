// src/lib/authDevMiddleware.ts
// PH15-BACKEND-AUTH-FIX-01: DEV auth middleware with X-User-Email support

import { FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "./db";
import type { AuthUser } from "../modules/auth/auth.types";

const DEV_MODE = process.env.NODE_ENV !== "production" || process.env.DEV_AUTH === "true";

export async function devAuthMiddleware(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const authHeader = request.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    try {
      await request.jwtVerify();
      return;
    } catch (err) {
      if (!DEV_MODE) {
        return reply.status(401).send({ error: "Invalid token" });
      }
    }
  }

  if (DEV_MODE) {
    const email = request.headers["x-user-email"] as string;
    const tenantIdHeader = request.headers["x-tenant-id"] as string;
    
    if (email) {
      try {
        const user = await prisma.user.findFirst({ where: { email } });
        if (!user) {
          console.log("[AuthDev] User not found:", email);
          return reply.status(401).send({ error: "User not found" });
        }

        const tenantId = tenantIdHeader || (user as any).tenantId || "tenant_test_dev";
        const authUser: AuthUser = {
          id: user.id,
          email: user.email,
          fullName: (user as any).name || email.split("@")[0],
          tenantId: tenantId,
          role: "super_admin",
        };

        (request as any).user = authUser;
        console.log("[AuthDev] Auth via X-User-Email:", email, "tenant:", tenantId);
        return;
      } catch (err) {
        console.error("[AuthDev] Error:", err);
        return reply.status(500).send({ error: "Auth error" });
      }
    }
  }

  return reply.status(401).send({ 
    error: "Unauthorized",
    hint: DEV_MODE ? "Provide Authorization header or X-User-Email" : "Provide Authorization header"
  });
}
