import { PrismaClient } from "@prisma/client";

export const prisma = new PrismaClient();

export async function testDbConnection(): Promise<boolean> {
  const res = await prisma.$queryRaw<{ ok: number }[]>`SELECT 1 as ok`;
  return Array.isArray(res) && res[0]?.ok === 1;
}

