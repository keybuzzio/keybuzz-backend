-- PH15.2-AMAZON-ORDERS-BACKFILL-365D-01
-- Add initial backfill tracking fields to MarketplaceSyncState

-- Add new columns to MarketplaceSyncState
ALTER TABLE "MarketplaceSyncState" 
ADD COLUMN IF NOT EXISTS "initialBackfillDays" INTEGER,
ADD COLUMN IF NOT EXISTS "initialBackfillDoneAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "initialBackfillStatus" TEXT;

-- Add index on Order(tenantId, externalOrderId) for efficient upsert
CREATE INDEX IF NOT EXISTS "Order_tenantId_externalOrderId_idx" ON "Order"("tenantId", "externalOrderId");

-- Add index on Order(tenantId, orderDate DESC) for date range queries
CREATE INDEX IF NOT EXISTS "Order_tenantId_orderDate_desc_idx" ON "Order"("tenantId", "orderDate" DESC);

-- Comment on purpose
COMMENT ON COLUMN "MarketplaceSyncState"."initialBackfillDays" IS 'Number of days for initial backfill (default 365)';
COMMENT ON COLUMN "MarketplaceSyncState"."initialBackfillDoneAt" IS 'Timestamp when initial backfill completed';
COMMENT ON COLUMN "MarketplaceSyncState"."initialBackfillStatus" IS 'Status: success/failed/in_progress';