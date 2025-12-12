-- PH11-05C.1 AI cost guardrails & usage logging

CREATE TABLE "AiUsageLog" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "ticketId" TEXT,
  "ruleId" TEXT,
  "provider" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "taskType" TEXT NOT NULL,
  "tokensInput" INTEGER NOT NULL,
  "tokensOutput" INTEGER NOT NULL,
  "estimatedCost" INTEGER NOT NULL,
  "latencyMs" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AiUsageLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AiUsageLog_tenantId_createdAt_idx" ON "AiUsageLog"("tenantId", "createdAt");

CREATE TABLE "TenantAiBudget" (
  "tenantId" TEXT NOT NULL,
  "monthlyBudgetCents" INTEGER NOT NULL,
  "softLimitPercent" INTEGER NOT NULL,
  "downgradePercent" INTEGER NOT NULL,
  "hardLimitPercent" INTEGER NOT NULL,
  "autoRechargeEnabled" BOOLEAN NOT NULL,
  "autoRechargeAmountCents" INTEGER NOT NULL,
  "maxAutoRechargesPerMonth" INTEGER NOT NULL,
  "maxAutoRechargesPerDay" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TenantAiBudget_pkey" PRIMARY KEY ("tenantId")
);

