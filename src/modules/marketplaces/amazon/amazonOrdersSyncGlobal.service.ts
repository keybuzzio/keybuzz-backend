// src/modules/marketplaces/amazon/amazonOrdersSyncGlobal.service.ts
// PH15-AMAZON-ORDERS-SYNC-SCALE-01: Global multi-tenant sync for Amazon Orders

import { prisma } from "../../../lib/db";
import { runOrdersDeltaSync, getSyncStatus } from "./amazonOrdersSync.service";
import { MarketplaceType } from "@prisma/client";

const BATCH_SIZE = 5; // Max tenants per run
const INTER_TENANT_DELAY_MS = 2000; // 2s between tenants

interface GlobalSyncResult {
  success: boolean;
  tenantsProcessed: number;
  tenantsSkipped: number;
  results: {
    tenantId: string;
    success: boolean;
    ordersProcessed: number;
    itemsProcessed: number;
    error?: string;
  }[];
  totalDuration: number;
}

interface TenantSyncStatus {
  tenantId: string;
  displayName: string | null;
  connectionStatus: string;
  syncState: {
    lastUpdatedAfter: string | null;
    lastPolledAt: string | null;
    lastSuccessAt: string | null;
    lastError: string | null;
  } | null;
  counts: {
    orders: number;
    items: number;
  };
}

/**
 * Get all tenants with CONNECTED Amazon marketplace
 * Ordered by lastSuccessAt ASC (prioritize tenants not synced recently)
 */
async function getConnectedAmazonTenants(limit: number = BATCH_SIZE): Promise<string[]> {
  // Get all CONNECTED tenants
  const connections = await prisma.marketplaceConnection.findMany({
    where: {
      type: MarketplaceType.AMAZON,
      status: "CONNECTED",
    },
    select: {
      tenantId: true,
    },
  });

  if (connections.length === 0) {
    console.log("[Global Sync] No CONNECTED Amazon tenants found");
    return [];
  }

  const tenantIds = connections.map(c => c.tenantId);
  console.log(`[Global Sync] Found ${tenantIds.length} CONNECTED tenants: ${tenantIds.join(", ")}`);

  // Get sync states to order by lastSuccessAt
  const syncStates = await prisma.marketplaceSyncState.findMany({
    where: {
      tenantId: { in: tenantIds },
      type: MarketplaceType.AMAZON,
    },
    select: {
      tenantId: true,
      lastSuccessAt: true,
    },
    orderBy: {
      lastSuccessAt: "asc", // Prioritize tenants not synced recently
    },
  });

  // Build priority list: tenants without sync state first, then by lastSuccessAt
  const syncStateMap = new Map(syncStates.map(s => [s.tenantId, s.lastSuccessAt]));
  
  const sortedTenants = [...tenantIds].sort((a, b) => {
    const aTime = syncStateMap.get(a)?.getTime() ?? 0;
    const bTime = syncStateMap.get(b)?.getTime() ?? 0;
    return aTime - bTime; // Earliest first
  });

  return sortedTenants.slice(0, limit);
}

/**
 * Try to acquire an advisory lock for a tenant
 * Returns true if lock acquired, false if already locked
 */
async function tryAcquireLock(tenantId: string): Promise<boolean> {
  // Use a hash of the tenantId as the lock key
  const lockKey = hashTenantId(tenantId);
  
  try {
    const result = await prisma.$queryRaw<[{ pg_try_advisory_lock: boolean }]>`
      SELECT pg_try_advisory_lock(${lockKey}) as pg_try_advisory_lock
    `;
    return result[0]?.pg_try_advisory_lock ?? false;
  } catch (error) {
    console.error(`[Global Sync] Failed to acquire lock for ${tenantId}:`, error);
    return false;
  }
}

/**
 * Release the advisory lock for a tenant
 */
async function releaseLock(tenantId: string): Promise<void> {
  const lockKey = hashTenantId(tenantId);
  
  try {
    await prisma.$queryRaw`SELECT pg_advisory_unlock(${lockKey})`;
  } catch (error) {
    console.error(`[Global Sync] Failed to release lock for ${tenantId}:`, error);
  }
}

/**
 * Simple hash function to convert tenantId to a numeric lock key
 */
function hashTenantId(tenantId: string): number {
  let hash = 0;
  for (let i = 0; i < tenantId.length; i++) {
    const char = tenantId.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  // Use absolute value and add a namespace prefix to avoid collisions
  return Math.abs(hash) + 1000000; // Offset to avoid common lock keys
}

/**
 * Run global sync for all CONNECTED Amazon tenants
 * Processes in batches with advisory locks
 */
export async function runGlobalOrdersSync(): Promise<GlobalSyncResult> {
  const startTime = Date.now();
  console.log("[Global Sync] Starting multi-tenant Amazon Orders sync...");
  
  const result: GlobalSyncResult = {
    success: true,
    tenantsProcessed: 0,
    tenantsSkipped: 0,
    results: [],
    totalDuration: 0,
  };

  try {
    // Get tenants to process (limited to BATCH_SIZE)
    const tenants = await getConnectedAmazonTenants(BATCH_SIZE);
    
    if (tenants.length === 0) {
      console.log("[Global Sync] No tenants to process");
      result.totalDuration = Date.now() - startTime;
      return result;
    }

    console.log(`[Global Sync] Processing ${tenants.length} tenants: ${tenants.join(", ")}`);

    // Process each tenant
    for (const tenantId of tenants) {
      console.log(`[Global Sync] Processing tenant: ${tenantId}`);
      
      // Try to acquire lock
      const lockAcquired = await tryAcquireLock(tenantId);
      
      if (!lockAcquired) {
        console.log(`[Global Sync] Skipping ${tenantId} - lock unavailable (already being synced)`);
        result.tenantsSkipped++;
        result.results.push({
          tenantId,
          success: false,
          ordersProcessed: 0,
          itemsProcessed: 0,
          error: "Lock unavailable - sync already in progress",
        });
        continue;
      }

      try {
        // Run delta sync for this tenant
        const syncResult = await runOrdersDeltaSync(tenantId);
        
        result.tenantsProcessed++;
        result.results.push({
          tenantId,
          success: syncResult.success,
          ordersProcessed: syncResult.ordersProcessed,
          itemsProcessed: syncResult.itemsProcessed,
          error: syncResult.errors.length > 0 ? syncResult.errors[0] : undefined,
        });

        console.log(`[Global Sync] ${tenantId}: ${syncResult.ordersProcessed} orders, ${syncResult.itemsProcessed} items`);

      } catch (error) {
        const errorMsg = (error as Error).message;
        console.error(`[Global Sync] Error processing ${tenantId}:`, errorMsg);
        
        result.results.push({
          tenantId,
          success: false,
          ordersProcessed: 0,
          itemsProcessed: 0,
          error: errorMsg,
        });
      } finally {
        // Always release the lock
        await releaseLock(tenantId);
      }

      // Delay between tenants to respect rate limits
      if (tenants.indexOf(tenantId) < tenants.length - 1) {
        console.log(`[Global Sync] Waiting ${INTER_TENANT_DELAY_MS}ms before next tenant...`);
        await new Promise(r => setTimeout(r, INTER_TENANT_DELAY_MS));
      }
    }

  } catch (error) {
    console.error("[Global Sync] Fatal error:", error);
    result.success = false;
  }

  result.totalDuration = Date.now() - startTime;
  console.log(`[Global Sync] Completed in ${result.totalDuration}ms: ${result.tenantsProcessed} processed, ${result.tenantsSkipped} skipped`);
  
  return result;
}

/**
 * Get sync status for all CONNECTED Amazon tenants
 */
export async function getGlobalSyncStatus(): Promise<TenantSyncStatus[]> {
  // Get all CONNECTED tenants
  const connections = await prisma.marketplaceConnection.findMany({
    where: {
      type: MarketplaceType.AMAZON,
      status: "CONNECTED",
    },
    select: {
      tenantId: true,
      displayName: true,
      status: true,
    },
  });

  const results: TenantSyncStatus[] = [];

  for (const conn of connections) {
    const status = await getSyncStatus(conn.tenantId);
    
    results.push({
      tenantId: conn.tenantId,
      displayName: conn.displayName,
      connectionStatus: conn.status,
      syncState: status.syncState,
      counts: status.counts,
    });
  }

  // Sort by lastSuccessAt (oldest first)
  results.sort((a, b) => {
    const aTime = a.syncState?.lastSuccessAt ? new Date(a.syncState.lastSuccessAt).getTime() : 0;
    const bTime = b.syncState?.lastSuccessAt ? new Date(b.syncState.lastSuccessAt).getTime() : 0;
    return aTime - bTime;
  });

  return results;
}