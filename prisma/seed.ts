import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const tenant1 = await prisma.tenant.upsert({
    where: { slug: "acme-electronics" },
    update: {},
    create: {
      slug: "acme-electronics",
      name: "Acme Electronics",
      plan: "PRO",
      status: "ACTIVE",
    },
  });

  const tenant2 = await prisma.tenant.upsert({
    where: { slug: "techcorp-solutions" },
    update: {},
    create: {
      slug: "techcorp-solutions",
      name: "TechCorp Solutions",
      plan: "ENTERPRISE",
      status: "ACTIVE",
    },
  });

  const tenant3 = await prisma.tenant.upsert({
    where: { slug: "globex-retail" },
    update: {},
    create: {
      slug: "globex-retail",
      name: "Globex Retail",
      plan: "STARTER",
      status: "TRIAL",
    },
  });

  await prisma.user.upsert({
    where: { email: "admin@keybuzz.io" },
    update: {},
    create: {
      email: "admin@keybuzz.io",
      fullName: "KeyBuzz Super Admin",
      role: "SUPER_ADMIN",
      passwordHash: "TODO_HASH",
    },
  });

  await prisma.user.upsert({
    where: { email: "owner@acme-electronics.com" },
    update: {},
    create: {
      email: "owner@acme-electronics.com",
      fullName: "Acme Owner",
      role: "OWNER",
      tenantId: tenant1.id,
      passwordHash: "TODO_HASH",
    },
  });

  await prisma.user.upsert({
    where: { email: "admin@techcorp-solutions.com" },
    update: {},
    create: {
      email: "admin@techcorp-solutions.com",
      fullName: "TechCorp Admin",
      role: "ADMIN",
      tenantId: tenant2.id,
      passwordHash: "TODO_HASH",
    },
  });

  await prisma.user.upsert({
    where: { email: "owner@globex-retail.com" },
    update: {},
    create: {
      email: "owner@globex-retail.com",
      fullName: "Globex Owner",
      role: "OWNER",
      tenantId: tenant3.id,
      passwordHash: "TODO_HASH",
    },
  });
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

