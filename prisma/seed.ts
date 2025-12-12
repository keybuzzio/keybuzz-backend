import { PrismaClient } from "@prisma/client";
import bcrypt from "bcrypt";

const prisma = new PrismaClient();
const saltRounds = 10;

async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, saltRounds);
}

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

  const superAdminPassword = await hashPassword("change-me");
  const ownerAcmePassword = await hashPassword("owner-acme-123");
  const adminTechcorpPassword = await hashPassword("admin-techcorp-123");
  const ownerGlobexPassword = await hashPassword("owner-globex-123");

  await prisma.user.upsert({
    where: { email: "admin@keybuzz.io" },
    update: {},
    create: {
      email: "admin@keybuzz.io",
      fullName: "KeyBuzz Super Admin",
      role: "SUPER_ADMIN",
      tenantId: null,
      passwordHash: superAdminPassword,
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
      passwordHash: ownerAcmePassword,
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
      passwordHash: adminTechcorpPassword,
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
      passwordHash: ownerGlobexPassword,
    },
  });

  // Créer les BillingPlans pour chaque tenant
  await prisma.tenantBillingPlan.upsert({
    where: { tenantId: tenant1.id },
    update: {},
    create: {
      tenantId: tenant1.id,
      plan: "PRO",
      ticketMonthlyQuota: 1000,
      softLimitPercent: 80,
      hardLimitPercent: 100,
      autoRechargeEnabled: true,
      autoRechargeUnits: 200,
      ticketUnitPrice: 0.1,
      aiActionUnitPrice: 0.05,
    },
  });

  await prisma.tenantBillingPlan.upsert({
    where: { tenantId: tenant2.id },
    update: {},
    create: {
      tenantId: tenant2.id,
      plan: "ENTERPRISE",
      ticketMonthlyQuota: 5000,
      softLimitPercent: 80,
      hardLimitPercent: 100,
      autoRechargeEnabled: true,
      autoRechargeUnits: 1000,
      ticketUnitPrice: 0.08,
      aiActionUnitPrice: 0.04,
    },
  });

  await prisma.tenantBillingPlan.upsert({
    where: { tenantId: tenant3.id },
    update: {},
    create: {
      tenantId: tenant3.id,
      plan: "STARTER",
      ticketMonthlyQuota: 100,
      softLimitPercent: 80,
      hardLimitPercent: 100,
      autoRechargeEnabled: false,
      autoRechargeUnits: 50,
      ticketUnitPrice: 0.15,
      aiActionUnitPrice: 0.08,
    },
  });

  // Créer une règle IA pour tenant1 (PRO -> AUTO mode)
  const rule1 = await prisma.aiRule.upsert({
    where: { id: "rule-acme-amazon" },
    update: {},
    create: {
      id: "rule-acme-amazon",
      tenantId: tenant1.id,
      name: "Auto-set pending for Amazon tickets",
      description: "Automatically set status to PENDING for Amazon channel tickets",
      isActive: true,
      trigger: "INCOMING_MESSAGE",
      executionMode: "AUTO_EXECUTE",
    },
  });

  await prisma.aiRuleCondition.upsert({
    where: { id: "cond-rule-acme-amazon" },
    update: {},
    create: {
      id: "cond-rule-acme-amazon",
      ruleId: rule1.id,
      field: "channel",
      operator: "EQUALS",
      value: "AMAZON",
    },
  });

  await prisma.aiRuleAction.upsert({
    where: { id: "action-rule-acme-amazon" },
    update: {},
    create: {
      id: "action-rule-acme-amazon",
      ruleId: rule1.id,
      type: "SET_STATUS",
      params: { status: "PENDING" },
    },
  });

  // Créer une règle IA pour tenant3 (STARTER -> ASSIST mode)
  const rule3 = await prisma.aiRule.upsert({
    where: { id: "rule-globex-assist" },
    update: {},
    create: {
      id: "rule-globex-assist",
      tenantId: tenant3.id,
      name: "Suggest reply for Amazon tickets (assist mode)",
      description: "Suggest AI reply for Amazon channel tickets (assist mode, no auto actions)",
      isActive: true,
      trigger: "INCOMING_MESSAGE",
      executionMode: "SUGGEST_ONLY",
    },
  });

  await prisma.aiRuleCondition.upsert({
    where: { id: "cond-rule-globex-assist" },
    update: {},
    create: {
      id: "cond-rule-globex-assist",
      ruleId: rule3.id,
      field: "channel",
      operator: "EQUALS",
      value: "AMAZON",
    },
  });

  // Budgets IA par tenant
  const defaultBudget = {
    monthlyBudgetCents: 5000, // 50€
    softLimitPercent: 70,
    downgradePercent: 85,
    hardLimitPercent: 100,
    autoRechargeEnabled: true,
    autoRechargeAmountCents: 1000, // 10€
    maxAutoRechargesPerMonth: 10,
    maxAutoRechargesPerDay: 2,
  };

  await prisma.tenantAiBudget.upsert({
    where: { tenantId: tenant1.id },
    update: {},
    create: {
      tenantId: tenant1.id,
      ...defaultBudget,
    },
  });

  await prisma.tenantAiBudget.upsert({
    where: { tenantId: tenant2.id },
    update: {},
    create: {
      tenantId: tenant2.id,
      ...defaultBudget,
    },
  });

  await prisma.tenantAiBudget.upsert({
    where: { tenantId: tenant3.id },
    update: {},
    create: {
      tenantId: tenant3.id,
      ...defaultBudget,
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
