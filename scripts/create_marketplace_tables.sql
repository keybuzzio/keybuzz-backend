-- Migration: PH11-06A Amazon Connections + External Messages
-- Generated: 2025-12-14

-- Create enums
DO $$ BEGIN
    CREATE TYPE "MarketplaceType" AS ENUM ('AMAZON', 'FNAC', 'CDISCOUNT', 'OTHER');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE "MarketplaceConnectionStatus" AS ENUM ('PENDING', 'CONNECTED', 'ERROR', 'DISABLED');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- Create MarketplaceConnection table
CREATE TABLE IF NOT EXISTS "MarketplaceConnection" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "type" "MarketplaceType" NOT NULL,
    "status" "MarketplaceConnectionStatus" NOT NULL DEFAULT 'PENDING',
    "displayName" TEXT,
    "region" TEXT,
    "marketplaceId" TEXT,
    "vaultPath" TEXT,
    "lastSyncAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketplaceConnection_pkey" PRIMARY KEY ("id")
);

-- Create indexes for MarketplaceConnection
CREATE INDEX IF NOT EXISTS "MarketplaceConnection_tenantId_type_idx" ON "MarketplaceConnection"("tenantId", "type");

-- Create MarketplaceSyncState table
CREATE TABLE IF NOT EXISTS "MarketplaceSyncState" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "type" "MarketplaceType" NOT NULL,
    "cursor" TEXT,
    "lastPolledAt" TIMESTAMP(3),
    "lastSuccessAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketplaceSyncState_pkey" PRIMARY KEY ("id")
);

-- Create indexes for MarketplaceSyncState
CREATE INDEX IF NOT EXISTS "MarketplaceSyncState_tenantId_type_idx" ON "MarketplaceSyncState"("tenantId", "type");
CREATE INDEX IF NOT EXISTS "MarketplaceSyncState_connectionId_idx" ON "MarketplaceSyncState"("connectionId");

-- Create ExternalMessage table
CREATE TABLE IF NOT EXISTS "ExternalMessage" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "type" "MarketplaceType" NOT NULL,
    "externalId" TEXT NOT NULL,
    "threadId" TEXT,
    "orderId" TEXT,
    "buyerName" TEXT,
    "buyerEmail" TEXT,
    "language" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "raw" JSONB NOT NULL,
    "ticketId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExternalMessage_pkey" PRIMARY KEY ("id")
);

-- Create unique constraint and indexes for ExternalMessage
CREATE UNIQUE INDEX IF NOT EXISTS "ExternalMessage_type_connectionId_externalId_key" ON "ExternalMessage"("type", "connectionId", "externalId");
CREATE INDEX IF NOT EXISTS "ExternalMessage_tenantId_receivedAt_idx" ON "ExternalMessage"("tenantId", "receivedAt");
CREATE INDEX IF NOT EXISTS "ExternalMessage_ticketId_idx" ON "ExternalMessage"("ticketId");

