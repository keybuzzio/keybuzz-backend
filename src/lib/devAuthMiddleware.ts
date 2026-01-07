// src/lib/devAuthMiddleware.ts
// DEV-only authentication bridge using X-User-Email header
// In production, use JWT authentication

import type { FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "./db";
import type { AuthUser } from "../modules/auth/auth.types";

/**
 * DEV authentication middleware
 * Accepts X-User-Email header to identify user + tenant
 * Falls back to JWT authentication if header not present
 */
export async function devAuthenticateOrJwt(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  // DEV mode: accept X-User-Email header
  const isDevMode = process.env.NODE_ENV !== "production" || process.env.KEYBUZZ_DEV_MODE === "true";
  const userEmail = request.headers["x-user-email"] as string | undefined;
  const tenantIdHeader = request.headers["x-tenant-id"] as string | undefined;

  // In DEV mode with X-User-Email header, use DEV bridge
  if (isDevMode && userEmail) {
    try {
      // Find user by email
      const dbUser = await prisma.user.findUnique({
        where: { email: userEmail },
        include: { tenant: true },
      });

      if (!dbUser) {
        // User not found - create a minimal context with tenant from header
        if (tenantIdHeader) {
          // Check if tenant exists
          const tenant = await prisma.tenant.findUnique({
            where: { id: tenantIdHeader },
          });

          if (tenant) {
            // Cast to any to bypass JwtUser type conflict
            (request as any).user = {
              id: "dev-user",
              tenantId: tenantIdHeader,
              email: userEmail,
              fullName: userEmail.split("@")[0],
              role: "super_admin",
            } as AuthUser;
            return;
          }
        }
        
        return reply.status(401).send({ 
          error: "Unauthorized", 
          message: "User not found in database" 
        });
      }

      // Use tenant from header if provided, otherwise use user's tenant
      const effectiveTenantId = tenantIdHeader || dbUser.tenantId || "";

      // Cast to any to bypass JwtUser type conflict
      (request as any).user = {
        id: dbUser.id,
        tenantId: effectiveTenantId,
        email: dbUser.email,
        fullName: dbUser.fullName,
        role: dbUser.role.toLowerCase() as AuthUser["role"],
      } as AuthUser;

      return;
    } catch (error) {
      console.error("[DevAuth] Error:", error);
      return reply.status(500).send({ 
        error: "Internal Server Error", 
        message: "Authentication failed" 
      });
    }
  }

  // Production mode or no X-User-Email: use JWT
  try {
    await request.jwtVerify();
  } catch (err) {
    return reply.status(401).send({ 
      error: "Unauthorized", 
      message: "Invalid or missing JWT token" 
    });
  }
}
