// src/modules/marketplaces/amazon/amazonReports.service.ts
// PH15-TRACKING-REPORTS-02: Amazon Reports API for FBM tracking

import { getAccessToken } from "./amazon.tokens";
import { getAmazonTenantCredentials } from "./amazon.vault";
import { normalizeCarrierName, buildTrackingUrl } from "./carrierTracking.service";
import { prisma } from "../../../lib/db";
import { TrackingSource, MarketplaceType } from "@prisma/client";

const SPAPI_ENDPOINTS: Record<string, string> = {
  "eu-west-1": "https://sellingpartnerapi-eu.amazon.com",
  "us-east-1": "https://sellingpartnerapi-na.amazon.com",
  "us-west-2": "https://sellingpartnerapi-fe.amazon.com",
};

interface ReportResponse {
  reportId?: string;
  reportDocumentId?: string;
  processingStatus?: string;
  reportType?: string;
  errors?: Array<{ code: string; message: string }>;
}

interface ReportDocumentResponse {
  reportDocumentId: string;
  url: string;
  compressionAlgorithm?: string;
}

interface TrackingData {
  amazonOrderId: string;
  carrierName: string | null;
  trackingNumber: string | null;
  shipDate: string | null;
}

/**
 * Create a report request via SP-API
 */
async function createReport(
  tenantId: string,
  marketplaceId: string,
  startDate: Date,
  endDate: Date
): Promise<string> {
  const creds = await getAmazonTenantCredentials(tenantId);
  if (!creds || !creds.refresh_token) {
    throw new Error("Amazon OAuth not connected - no refresh token");
  }

  const accessToken = await getAccessToken(creds.refresh_token);
  const region = creds.region || "eu-west-1";
  const endpoint = SPAPI_ENDPOINTS[region] || SPAPI_ENDPOINTS["eu-west-1"];

  const requestBody = {
    reportType: "GET_MERCHANT_FULFILLED_SHIPMENTS_DATA",
    dataStartTime: startDate.toISOString(),
    dataEndTime: endDate.toISOString(),
    marketplaceIds: [marketplaceId],
  };

  console.log(`[Reports] Creating report for tenant ${tenantId}:`, {
    type: requestBody.reportType,
    start: requestBody.dataStartTime,
    end: requestBody.dataEndTime,
  });

  const response = await fetch(`${endpoint}/reports/2021-06-30/reports`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-amz-access-token": accessToken,
    },
    body: JSON.stringify(requestBody),
  });

  const data: ReportResponse = await response.json();

  if (!response.ok || data.errors) {
    const errorMsg = data.errors?.[0]?.message || `HTTP ${response.status}`;
    throw new Error(`Failed to create report: ${errorMsg}`);
  }

  if (!data.reportId) {
    throw new Error("No reportId in response");
  }

  console.log(`[Reports] Report created: ${data.reportId}`);
  return data.reportId;
}

/**
 * Poll report status until ready (with backoff)
 */
async function pollReportStatus(
  tenantId: string,
  reportId: string,
  maxAttempts: number = 30,
  initialDelayMs: number = 5000
): Promise<string> {
  const creds = await getAmazonTenantCredentials(tenantId);
  if (!creds || !creds.refresh_token) {
    throw new Error("Amazon OAuth not connected");
  }

  const accessToken = await getAccessToken(creds.refresh_token);
  const region = creds.region || "eu-west-1";
  const endpoint = SPAPI_ENDPOINTS[region] || SPAPI_ENDPOINTS["eu-west-1"];

  let delay = initialDelayMs;
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    console.log(`[Reports] Polling report ${reportId} (attempt ${attempt}/${maxAttempts})...`);
    
    const response = await fetch(`${endpoint}/reports/2021-06-30/reports/${reportId}`, {
      method: "GET",
      headers: {
        "x-amz-access-token": accessToken,
      },
    });

    const data: ReportResponse = await response.json();

    if (!response.ok) {
      throw new Error(`Failed to get report status: ${response.status}`);
    }

    const status = data.processingStatus;
    console.log(`[Reports] Report status: ${status}`);

    if (status === "DONE" && data.reportDocumentId) {
      return data.reportDocumentId;
    }

    if (status === "CANCELLED" || status === "FATAL") {
      throw new Error(`Report failed with status: ${status}`);
    }

    // Wait before next poll (with exponential backoff)
    await new Promise(resolve => setTimeout(resolve, delay));
    delay = Math.min(delay * 1.5, 60000); // Max 60s between polls
  }

  throw new Error(`Report polling timeout after ${maxAttempts} attempts`);
}

/**
 * Download report document
 */
async function downloadReportDocument(
  tenantId: string,
  reportDocumentId: string
): Promise<string> {
  const creds = await getAmazonTenantCredentials(tenantId);
  if (!creds || !creds.refresh_token) {
    throw new Error("Amazon OAuth not connected");
  }

  const accessToken = await getAccessToken(creds.refresh_token);
  const region = creds.region || "eu-west-1";
  const endpoint = SPAPI_ENDPOINTS[region] || SPAPI_ENDPOINTS["eu-west-1"];

  // Get document URL
  const docResponse = await fetch(
    `${endpoint}/reports/2021-06-30/documents/${reportDocumentId}`,
    {
      method: "GET",
      headers: {
        "x-amz-access-token": accessToken,
      },
    }
  );

  if (!docResponse.ok) {
    throw new Error(`Failed to get report document: ${docResponse.status}`);
  }

  const docData: ReportDocumentResponse = await docResponse.json();
  console.log(`[Reports] Downloading from: ${docData.url.substring(0, 100)}...`);

  // Download the actual content
  const contentResponse = await fetch(docData.url);
  if (!contentResponse.ok) {
    throw new Error(`Failed to download report: ${contentResponse.status}`);
  }

  const content = await contentResponse.text();
  console.log(`[Reports] Downloaded ${content.length} bytes`);

  return content;
}

/**
 * Parse tracking data from TSV report
 */
function parseTrackingReport(content: string): TrackingData[] {
  const lines = content.split("\n");
  if (lines.length < 2) {
    console.log(`[Reports] Empty or invalid report`);
    return [];
  }

  // Parse header to find column indices
  const header = lines[0].toLowerCase().split("\t");
  const orderIdIdx = header.findIndex((h: string) => 
    h.includes("amazon-order-id") || h.includes("order-id") || h === "order id"
  );
  const carrierIdx = header.findIndex((h: string) => 
    h.includes("carrier") || h.includes("ship-service-level")
  );
  const trackingIdx = header.findIndex((h: string) => 
    h.includes("tracking") || h.includes("tracking-number")
  );
  const shipDateIdx = header.findIndex((h: string) => 
    h.includes("ship-date") || h.includes("shipment-date")
  );

  console.log(`[Reports] Column indices - orderId:${orderIdIdx}, carrier:${carrierIdx}, tracking:${trackingIdx}, shipDate:${shipDateIdx}`);

  if (orderIdIdx === -1) {
    console.error(`[Reports] Could not find order ID column in header: ${header.join(", ")}`);
    return [];
  }

  const results: TrackingData[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const cols = line.split("\t");
    const amazonOrderId = cols[orderIdIdx]?.trim();
    
    if (!amazonOrderId) continue;

    const carrierName = carrierIdx !== -1 ? cols[carrierIdx]?.trim() || null : null;
    const trackingNumber = trackingIdx !== -1 ? cols[trackingIdx]?.trim() || null : null;
    const shipDate = shipDateIdx !== -1 ? cols[shipDateIdx]?.trim() || null : null;

    // Skip if no tracking number
    if (!trackingNumber) continue;

    results.push({
      amazonOrderId,
      carrierName,
      trackingNumber,
      shipDate,
    });
  }

  console.log(`[Reports] Parsed ${results.length} rows with tracking numbers`);
  return results;
}

/**
 * Merge tracking data with existing orders
 */
async function mergeTrackingWithOrders(
  tenantId: string,
  trackingData: TrackingData[]
): Promise<{ matched: number; updated: number; skipped: number }> {
  let matched = 0;
  let updated = 0;
  let skipped = 0;

  for (const data of trackingData) {
    // Find order by external order ID
    const order = await prisma.order.findFirst({
      where: {
        tenantId,
        externalOrderId: data.amazonOrderId,
      },
    });

    if (!order) {
      console.log(`[Reports] Order not found: ${data.amazonOrderId}`);
      continue;
    }

    matched++;

    // Skip if order already has valid tracking from Reports
    if (order.trackingCode && order.trackingSource === "REPORTS") {
      skipped++;
      continue;
    }

    // Skip if not FBM
    if (order.fulfillmentChannel === "FBA") {
      skipped++;
      continue;
    }

    // Normalize carrier and build tracking URL
    const normalizedCarrier = data.carrierName ? normalizeCarrierName(data.carrierName) : null;
    const carrier = normalizedCarrier?.name || order.carrier;
    const trackingUrl = buildTrackingUrl(carrier, data.trackingNumber);

    // Update order
    await prisma.order.update({
      where: { id: order.id },
      data: {
        trackingCode: data.trackingNumber,
        carrier: carrier || order.carrier,
        trackingUrl,
        trackingSource: "REPORTS" as TrackingSource,
        updatedAt: new Date(),
      },
    });

    updated++;
    console.log(`[Reports] Updated order ${data.amazonOrderId}: ${carrier} - ${data.trackingNumber}`);
  }

  return { matched, updated, skipped };
}

/**
 * Update reports sync state in DB (using a dedicated record)
 */
async function updateReportsSyncState(
  tenantId: string,
  state: { lastSuccessAt?: Date | null; lastError?: string | null; rowsProcessed?: number; ordersUpdated?: number }
): Promise<void> {
  // Use MarketplaceSyncState table with a connectionId for reports
  const syncKey = `reports_${tenantId}`;
  
  try {
    await prisma.marketplaceSyncState.upsert({
      where: { id: syncKey },
      create: {
        id: syncKey,
        connectionId: syncKey,
        tenantId,
        type: "AMAZON" as MarketplaceType,
        lastSuccessAt: state.lastSuccessAt || null,
        lastError: state.lastError || null,
        cursor: JSON.stringify({
          rowsProcessed: state.rowsProcessed || 0,
          ordersUpdated: state.ordersUpdated || 0,
          purpose: "REPORTS",
        }),
        lastPolledAt: new Date(),
      },
      update: {
        lastSuccessAt: state.lastSuccessAt,
        lastError: state.lastError,
        cursor: JSON.stringify({
          rowsProcessed: state.rowsProcessed || 0,
          ordersUpdated: state.ordersUpdated || 0,
          purpose: "REPORTS",
        }),
        lastPolledAt: new Date(),
      },
    });
  } catch (e) {
    console.error(`[Reports] Failed to update sync state:`, e);
  }
}

/**
 * Run reports sync for a single tenant
 */
export async function runReportsSyncForTenant(
  tenantId: string,
  daysBack: number = 30
): Promise<{
  success: boolean;
  reportId?: string;
  rowsParsed: number;
  ordersMatched: number;
  ordersUpdated: number;
  error?: string;
}> {
  console.log(`[Reports] Starting reports sync for tenant ${tenantId} (last ${daysBack} days)`);

  try {
    // Get credentials
    const creds = await getAmazonTenantCredentials(tenantId);
    if (!creds || !creds.refresh_token) {
      return {
        success: false,
        rowsParsed: 0,
        ordersMatched: 0,
        ordersUpdated: 0,
        error: "TOKEN_MISSING",
      };
    }

    const marketplaceId = creds.marketplace_id || "A13V1IB3VIYZZH"; // Amazon.fr

    // Calculate date range
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - daysBack);

    // 1. Create report
    const reportId = await createReport(tenantId, marketplaceId, startDate, endDate);

    // 2. Poll until ready
    const reportDocumentId = await pollReportStatus(tenantId, reportId);

    // 3. Download report
    const content = await downloadReportDocument(tenantId, reportDocumentId);

    // 4. Parse tracking data
    const trackingData = parseTrackingReport(content);

    // 5. Merge with orders
    const mergeResult = await mergeTrackingWithOrders(tenantId, trackingData);

    // 6. Update sync state
    await updateReportsSyncState(tenantId, {
      lastSuccessAt: new Date(),
      lastError: null,
      rowsProcessed: trackingData.length,
      ordersUpdated: mergeResult.updated,
    });

    console.log(`[Reports] Sync complete for ${tenantId}:`, {
      reportId,
      rowsParsed: trackingData.length,
      matched: mergeResult.matched,
      updated: mergeResult.updated,
      skipped: mergeResult.skipped,
    });

    return {
      success: true,
      reportId,
      rowsParsed: trackingData.length,
      ordersMatched: mergeResult.matched,
      ordersUpdated: mergeResult.updated,
    };

  } catch (error) {
    const errorMessage = (error as Error).message;
    console.error(`[Reports] Sync failed for ${tenantId}:`, errorMessage);

    await updateReportsSyncState(tenantId, {
      lastError: errorMessage,
      lastSuccessAt: null,
      rowsProcessed: 0,
      ordersUpdated: 0,
    });

    return {
      success: false,
      rowsParsed: 0,
      ordersMatched: 0,
      ordersUpdated: 0,
      error: errorMessage,
    };
  }
}

/**
 * Get reports sync status for all tenants
 */
export async function getReportsSyncStatus(): Promise<Array<{
  tenantId: string;
  lastSuccessAt: Date | null;
  lastError: string | null;
  rowsProcessed: number;
  ordersUpdated: number;
}>> {
  const states = await prisma.marketplaceSyncState.findMany({
    where: {
      id: { startsWith: "reports_" }
    },
  });

  return states.map((s) => {
    let parsed = { rowsProcessed: 0, ordersUpdated: 0 };
    try {
      if (s.cursor) parsed = JSON.parse(s.cursor as string);
    } catch {}

    return {
      tenantId: s.tenantId,
      lastSuccessAt: s.lastSuccessAt,
      lastError: s.lastError,
      rowsProcessed: parsed.rowsProcessed || 0,
      ordersUpdated: parsed.ordersUpdated || 0,
    };
  });
}

/**
 * Get connected Amazon tenants eligible for reports
 */
export async function getReportsEligibleTenants(): Promise<string[]> {
  const connections = await prisma.marketplaceConnection.findMany({
    where: {
      type: "AMAZON" as MarketplaceType,
      status: "CONNECTED",
    },
    select: {
      tenantId: true,
    },
  });

  // Filter to only tenants with refresh tokens
  const eligible: string[] = [];
  for (const conn of connections) {
    try {
      const creds = await getAmazonTenantCredentials(conn.tenantId);
      if (creds?.refresh_token) {
        eligible.push(conn.tenantId);
      }
    } catch {}
  }

  return eligible;
}

/**
 * Run global reports sync for all eligible tenants
 */
export async function runGlobalReportsSync(
  daysBack: number = 30,
  batchSize: number = 3
): Promise<{
  total: number;
  success: number;
  failed: number;
  results: Array<{
    tenantId: string;
    status: "success" | "failed" | "skipped";
    ordersUpdated?: number;
    error?: string;
  }>;
}> {
  console.log(`[Reports] Starting global reports sync (${daysBack} days, batch ${batchSize})`);

  const tenants = await getReportsEligibleTenants();
  console.log(`[Reports] Found ${tenants.length} eligible tenants`);

  const results: Array<{
    tenantId: string;
    status: "success" | "failed" | "skipped";
    ordersUpdated?: number;
    error?: string;
  }> = [];

  let success = 0;
  let failed = 0;

  // Process in batches
  for (let i = 0; i < tenants.length; i += batchSize) {
    const batch = tenants.slice(i, i + batchSize);
    
    // Process batch sequentially (to avoid rate limits)
    for (const tenantId of batch) {
      try {
        const result = await runReportsSyncForTenant(tenantId, daysBack);
        
        if (result.success) {
          success++;
          results.push({
            tenantId,
            status: "success",
            ordersUpdated: result.ordersUpdated,
          });
        } else {
          failed++;
          results.push({
            tenantId,
            status: "failed",
            error: result.error,
          });
        }
      } catch (error) {
        failed++;
        results.push({
          tenantId,
          status: "failed",
          error: (error as Error).message,
        });
      }

      // Delay between tenants to avoid rate limits
      await new Promise(r => setTimeout(r, 2000));
    }

    // Delay between batches
    if (i + batchSize < tenants.length) {
      await new Promise(r => setTimeout(r, 5000));
    }
  }

  console.log(`[Reports] Global sync complete: ${success} success, ${failed} failed`);

  return {
    total: tenants.length,
    success,
    failed,
    results,
  };
}
