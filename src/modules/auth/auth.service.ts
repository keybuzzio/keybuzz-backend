import bcrypt from "bcrypt";
import type { AuthUser, UserRole } from "./auth.types";
import { prisma } from "../../lib/db";

export async function hashPassword(plain: string): Promise<string> {
  const saltRounds = 10;
  return bcrypt.hash(plain, saltRounds);
}

function toAuthRole(role: string): UserRole {
  return role.toLowerCase() as UserRole;
}

export async function loginWithEmailPassword(
  email: string,
  password: string
): Promise<AuthUser | null> {
  const user = await prisma.user.findUnique({
    where: { email },
    include: { tenant: true },
  });

  if (!user) return null;

  const isValid = await bcrypt.compare(password, user.passwordHash);
  if (!isValid) return null;

  return {
    id: user.id,
    tenantId: user.tenantId ?? null,
    email: user.email,
    fullName: user.fullName,
    role: toAuthRole(user.role),
  };
}

