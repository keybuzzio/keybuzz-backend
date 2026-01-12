// src/modules/marketplaces/amazon/amazonOrdersSyncGlobal.service.ts
// PH15-AMAZON-ORDERS-SYNC-SCALE-02: Hardened global multi-tenant sync

import { prisma } from "../../../lib/db";
import { runOrdersDeltaSync, getSyncStatus } from "./amazonOrdersSync.service";
import { getAmazonTenantCredentials } from "./amazon.vault";
import { MarketplaceType } from "@prisma/client";

const BATCH_SIZE = 5;
const INTER_TENANT_DELAY_MS = 2000;

// Reason codes for structured results
export enum SyncReasonCode {
  SUCCESS = "SUCCESS",
  SKIPPED_LOCK_UNAVAILABLE = "LOCK_UNAVAILABLE",
  SKIPPED_NOT_CONNECTED = "NOT_CONNECTED",
  SKIPPED_TOKEN_MISSING = "TOKEN_MISSING",
  SKIPPED_INVALID_DATE_FIXED = "INVALID_DATE_FIXED",
  ERROR_RATE_LIMIT = "AMAZON_RATE_LIMIT",
  ERROR_UNKNOWN = "UNKNOWN_ERROR",
}

interface TenantSyncResult {
  tenantId: string;
  status: "success" | "skipped" | "failed";
  reasonCode: SyncReasonCode;
  ordersProcessed: number;
  itemsProcessed: number;
  message?: string;
}

interface GlobalSyncResult {
  success: boolean;
  summary: {
    total: number;
    success: number;
    skipped: number;
    failed: number;
  };
  results: TenantSyncResult[];
  totalDuration: number;
}

interface TenantSyncStatus {
  tenantId: string;
  displayName: string | null;
  connectionStatus: string;
  hasRefreshToken: boolean;
  syncState: {
    lastUpdatedAfter: string | null;
    lastPolledAt: string | null;
    lastSuccessAt: string | null;
    lastError: string | null;
  } | null;
  counts: { orders: number; items: number };
}

/**
 * Safe date parsing - returns fallback if invalid
 */
function safeDate(value: any, fallbackDaysAgo: number = 7): Date {
  if (!value) {
    const fallback = new Date();
    fallback.setDate(fallback.getDate() - fallbackDaysAgo);
    return fallback;
  }
  
  // If it's already a Date
  if (value instanceof Date && !isNaN(value.getTime())) {
    return value;
  }
  
  // Try to parse string
  if (typeof value === "string") {
    // Check if it looks like a date (ISO format)
    if (/^\d{4}-\d{2}-\d{2}/.test(value)) {
      const parsed = new Date(value);
      if (!isNaN(parsed.getTime())) {
        return parsed;
      }
    }
    // Not a valid date string (could be UUID or garbage)
  }
  
  // Fallback
  console.warn(`[SafeDate] Invalid date value: "${value}", using fallback`);
  const fallback = new Date();
  fallback.setDate(fallback.getDate() - fallbackDaysAgo);
  return fallback;
}

/**
 * Check if tenant has valid credentials in Vault
 */
async function hasValidCredentials(tenantId: string): Promise<boolean> {
  try {
    const creds = await getAmazonTenantCredentials(tenantId);
    return !!(creds && creds.refresh_token);
  } catch (error) {
    console.warn(`[Credentials Check] ${tenantId}: ${(error as Error).message}`);
    return false;
  }
}

/**
 * Fix invalid sync state cursor for a tenant
 */
async function fixInvalidSyncState(tenantId: string): Promise<void> {
  const state = await prisma.marketplaceSyncState.findFirst({
    where: { tenantId, type: MarketplaceType.AMAZON },
  });
  
  if (state && state.cursor) {
    // Check if cursor is a valid date
    const parsed = safeDate(state.cursor, 7);
    const isValid = /^\d{4}-\d{2}-\d{2}/.test(state.cursor);
    
    if (!isValid) {
      console.log(`[Fix SyncState] ${tenantId}: Fixing invalid cursor "${state.cursor}" -> "${parsed.toISOString()}"`);
      await prisma.marketplaceSyncState.update({
        where: { id: state.id },
        data: {
          cursor: parsed.toISOString(),
          lastError: `Fixed invalid cursor at ${new Date().toISOString()}`,
          updatedAt: new Date(),
        },
      });
    }
  }
}

/**
 * Get CONNECTED tenants with valid credentials
 */
async function getEligibleTenants(limit: number = BATCH_SIZE): Promise<{
  eligible: string[];
  skipped: { tenantId: string; reason: SyncReasonCode }[];
}> {
  // Get all CONNECTED tenants
  const connections = await prisma.marketplaceConnection.findMany({
    where: {
      type: MarketplaceType.AMAZON,
      status: "CONNECTED",
    },
    select: { tenantId: true },
  });

  if (connections.length === 0) {
    console.log("[Global Sync] No CONNECTED Amazon tenants found");
    return { eligible: [], skipped: [] };
  }

  const tenantIds = connections.map(c => c.tenantId);
  console.log(`[Global Sync] Found ${tenantIds.length} CONNECTED tenants: ${tenantIds.join(", ")}`);

  const eligible: string[] = [];
  const skipped: { tenantId: string; reason: SyncReasonCode }[] = [];

  // Check each tenant for valid credentials
  for (const tenantId of tenantIds) {
    const hasToken = await hasValidCredentials(tenantId);
    
    if (!hasToken) {
      console.log(`[Global Sync] ${tenantId}: No refresh token - skipping`);
      skipped.push({ tenantId, reason: SyncReasonCode.SKIPPED_TOKEN_MISSING });
      
      // Update connection status to reflect missing token
      await prisma.marketplaceConnection.updateMany({
        where: { tenantId, type: MarketplaceType.AMAZON },
        data: { lastError: "Refresh token missing in Vault" },
      });
      continue;
    }
    
    // Fix invalid sync state if needed
    await fixInvalidSyncState(tenantId);
    
    eligible.push(tenantId);
  }

  // Sort eligible by lastSuccessAt (oldest first)
  const syncStates = await prisma.marketplaceSyncState.findMany({
    where: { tenantId: { in: eligible }, type: MarketplaceType.AMAZON },
    select: { tenantId: true, lastSuccessAt: true },
    orderBy: { lastSuccessAt: "asc" },
  });

  const syncStateMap = new Map(syncStates.map(s => [s.tenantId, s.lastSuccessAt]));
  
  const sorted = [...eligible].sort((a, b) => {
    const aTime = syncStateMap.get(a)?.getTime() ?? 0;
    const bTime = syncStateMap.get(b)?.getTime() ?? 0;
    return aTime - bTime;
  });

  return { eligible: sorted.slice(0, limit), skipped };
}

// Advisory lock functions
function hashTenantId(tenantId: string): number {
  let hash = 0;
  for (let i = 0; i < tenantId.length; i++) {
    const char = tenantId.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash) + 1000000;
}

async function tryAcquireLock(tenantId: string): Promise<boolean> {
  try {
    const lockKey = hashTenantId(tenantId);
    const result = await prisma.$queryRaw<[{ pg_try_advisory_lock: boolean }]>`
      SELECT pg_try_advisory_lock(${lockKey}) as pg_try_advisory_lock
    `;
    return result[0]?.pg_try_advisory_lock ?? false;
  } catch (error) {
    console.error(`[Lock] Failed to acquire for ${tenantId}:`, error);
    return false;
  }
}

async function releaseLock(tenantId: string): Promise<void> {
  try {
    const lockKey = hashTenantId(tenantId);
    await prisma.$queryRaw`SELECT pg_advisory_unlock(${lockKey})`;
  } catch (error) {
    console.error(`[Lock] Failed to release for ${tenantId}:`, error);
  }
}

/**
 * Run global sync - HARDENED version
 */
export async function runGlobalOrdersSync(): Promise<GlobalSyncResult> {
  const startTime = Date.now();
  console.log("[Global Sync] Starting hardened multi-tenant sync...");
  
  const result: GlobalSyncResult = {
    success: true,
    summary: { total: 0, success: 0, skipped: 0, failed: 0 },
    results: [],
    totalDuration: 0,
  };

  try {
    // Phase 1: Get eligible tenants (with valid credentials)
    const { eligible, skipped } = await getEligibleTenants(BATCH_SIZE);
    
    // Add skipped tenants to results
    for (const { tenantId, reason } of skipped) {
      result.results.push({
        tenantId,
        status: "skipped",
        reasonCode: reason,
        ordersProcessed: 0,
        itemsProcessed: 0,
        message: getReasonMessage(reason),
      });
      result.summary.skipped++;
    }
    
    result.summary.total = eligible.length + skipped.length;
    
    if (eligible.length === 0) {
      console.log("[Global Sync] No eligible tenants to process");
      result.totalDuration = Date.now() - startTime;
      return result;
    }

    console.log(`[Global Sync] Processing ${eligible.length} eligible tenants`);

    // Phase 2: Process each eligible tenant
    for (const tenantId of eligible) {
      console.log(`[Global Sync] Processing: ${tenantId}`);
      
      // Try to acquire lock
      const lockAcquired = await tryAcquireLock(tenantId);
      
      if (!lockAcquired) {
        console.log(`[Global Sync] ${tenantId}: Lock unavailable - skipping`);
        result.results.push({
          tenantId,
          status: "skipped",
          reasonCode: SyncReasonCode.SKIPPED_LOCK_UNAVAILABLE,
          ordersProcessed: 0,
          itemsProcessed: 0,
          message: "Sync already in progress",
        });
        result.summary.skipped++;
        continue;
      }

      try {
        // Run delta sync (wrapped in try/catch)
        const syncResult = await runOrdersDeltaSync(tenantId);
        
        if (syncResult.success) {
          result.results.push({
            tenantId,
            status: "success",
            reasonCode: SyncReasonCode.SUCCESS,
            ordersProcessed: syncResult.ordersProcessed,
            itemsProcessed: syncResult.itemsProcessed,
          });
          result.summary.success++;
        } else {
          // Check for rate limit errors
          const isRateLimit = syncResult.errors.some(e => 
            e.includes("429") || e.includes("rate limit") || e.includes("QuotaExceeded")
          );
          
          result.results.push({
            tenantId,
            status: "failed",
            reasonCode: isRateLimit ? SyncReasonCode.ERROR_RATE_LIMIT : SyncReasonCode.ERROR_UNKNOWN,
            ordersProcessed: syncResult.ordersProcessed,
            itemsProcessed: syncResult.itemsProcessed,
            message: syncResult.errors[0]?.substring(0, 200),
          });
          result.summary.failed++;
          
          // Store error in sync state
          await prisma.marketplaceSyncState.updateMany({
            where: { tenantId, type: MarketplaceType.AMAZON },
            data: { lastError: syncResult.errors[0]?.substring(0, 500) || "Unknown error" },
          });
        }

        console.log(`[Global Sync] ${tenantId}: ${syncResult.ordersProcessed} orders, ${syncResult.itemsProcessed} items`);

      } catch (error) {
        const errorMsg = (error as Error).message;
        console.error(`[Global Sync] ${tenantId} ERROR:`, errorMsg);
        
        result.results.push({
          tenantId,
          status: "failed",
          reasonCode: SyncReasonCode.ERROR_UNKNOWN,
          ordersProcessed: 0,
          itemsProcessed: 0,
          message: errorMsg.substring(0, 200),
        });
        result.summary.failed++;
        
        // Store error
        await prisma.marketplaceSyncState.updateMany({
          where: { tenantId, type: MarketplaceType.AMAZON },
          data: { lastError: errorMsg.substring(0, 500) },
        });
      } finally {
        await releaseLock(tenantId);
      }

      // Delay between tenants
      if (eligible.indexOf(tenantId) < eligible.length - 1) {
        await new Promise(r => setTimeout(r, INTER_TENANT_DELAY_MS));
      }
    }

  } catch (error) {
    console.error("[Global Sync] Fatal error:", error);
    result.success = false;
  }

  result.totalDuration = Date.now() - startTime;
  console.log(`[Global Sync] Completed in ${result.totalDuration}ms: ${result.summary.success} success, ${result.summary.skipped} skipped, ${result.summary.failed} failed`);
  
  return result;
}

function getReasonMessage(code: SyncReasonCode): string {
  switch (code) {
    case SyncReasonCode.SKIPPED_TOKEN_MISSING:
      return "No refresh token in Vault - reconnect Amazon required";
    case SyncReasonCode.SKIPPED_NOT_CONNECTED:
      return "Marketplace not connected";
    case SyncReasonCode.SKIPPED_LOCK_UNAVAILABLE:
      return "Sync already in progress";
    case SyncReasonCode.ERROR_RATE_LIMIT:
      return "Amazon API rate limit exceeded";
    default:
      return "";
  }
}

/**
 * Get sync status for all CONNECTED Amazon tenants
 */
export async function getGlobalSyncStatus(): Promise<TenantSyncStatus[]> {
  const connections = await prisma.marketplaceConnection.findMany({
    where: { type: MarketplaceType.AMAZON, status: "CONNECTED" },
    select: { tenantId: true, displayName: true, status: true },
  });

  const results: TenantSyncStatus[] = [];

  for (const conn of connections) {
    const hasToken = await hasValidCredentials(conn.tenantId);
    const status = await getSyncStatus(conn.tenantId);
    
    results.push({
      tenantId: conn.tenantId,
      displayName: conn.displayName,
      connectionStatus: conn.status,
      hasRefreshToken: hasToken,
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