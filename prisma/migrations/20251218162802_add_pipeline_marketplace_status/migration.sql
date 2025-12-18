-- AlterTable
ALTER TABLE "inbound_addresses" ADD COLUMN IF NOT EXISTS "pipelineStatus" "InboundValidationStatus" NOT NULL DEFAULT 'PENDING';
ALTER TABLE "inbound_addresses" ADD COLUMN IF NOT EXISTS "marketplaceStatus" "InboundValidationStatus" NOT NULL DEFAULT 'PENDING';

-- CreateIndex
CREATE INDEX IF NOT EXISTS "inbound_addresses_pipelineStatus_marketplaceStatus_idx" ON "inbound_addresses"("pipelineStatus", "marketplaceStatus");
