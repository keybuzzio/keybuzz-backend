import type { Tenant } from "./tenants.types";
import type { Tenant as PrismaTenant } from "@prisma/client";
import { prisma } from "../../lib/db";

export async function getTenants(): Promise<Tenant[]> {
  const records = await prisma.tenant.findMany({
    orderBy: { createdAt: "asc" },
  });

  return records.map((t: PrismaTenant) => ({
    id: t.id,
    slug: t.slug,
    name: t.name,
    plan: t.plan.toLowerCase() as Tenant["plan"],
    status: t.status.toLowerCase() as Tenant["status"],
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt?.toISOString(),
  }));
}

