// src/modules/marketplaces/amazon/amazonOrdersBackfill.service.ts
// PH15.2-AMAZON-ORDERS-BACKFILL-365D-01: Initial backfill service

import { prisma } from "../../../lib/db";
import { getAccessToken } from "./amazon.tokens";
import { getAmazonTenantCredentials } from "./amazon.vault";
import { MarketplaceType, OrderStatus, DeliveryStatus } from "@prisma/client";

const SPAPI_ENDPOINTS: Record<string, string> = {
  "eu-west-1": "https://sellingpartnerapi-eu.amazon.com",
  "us-east-1": "https://sellingpartnerapi-na.amazon.com",
  "us-west-2": "https://sellingpartnerapi-fe.amazon.com",
};

const DEFAULT_BACKFILL_DAYS = 365;
const RATE_LIMIT_DELAY_MS = 500;
const BATCH_SIZE_ORDERS = 100;

interface BackfillResult {
  success: boolean;
  tenantId: string;
  daysBackfilled: number;
  ordersProcessed: number;
  itemsProcessed: number;
  errors: string[];
  durationMs: number;
}

function mapAmazonStatus(status: string): OrderStatus {
  switch (status) {
    case "Pending": return "PENDING";
    case "Unshipped": return "CONFIRMED";
    case "PartiallyShipped": return "SHIPPED";
    case "Shipped": return "SHIPPED";
    case "Canceled": return "CANCELLED";
    case "Unfulfillable": return "CANCELLED";
    default: return "PENDING";
  }
}

function mapDeliveryStatus(order: any): DeliveryStatus {
  if (order.NumberOfItemsShipped && order.NumberOfItemsShipped > 0) {
    if (order.NumberOfItemsUnshipped && order.NumberOfItemsUnshipped > 0) {
      return "SHIPPED";
    }
    return "IN_TRANSIT";
  }
  return "PREPARING";
}

function extractCarrier(order: any): string | null {
  if (order.AutomatedShippingSettings?.AutomatedCarrierName) {
    return order.AutomatedShippingSettings.AutomatedCarrierName;
  }
  return null;
}

// Fetch orders by creation date range (for backfill)
async function fetchOrdersByCreationDate(params: {
  tenantId: string;
  createdAfter: Date;
  createdBefore?: Date;
  nextToken?: string;
}): Promise<{ orders: any[]; nextToken?: string }> {
  const { tenantId, createdAfter, createdBefore, nextToken } = params;
  
  const creds = await getAmazonTenantCredentials(tenantId);
  if (!creds || !creds.refresh_token) {
    throw new Error("Amazon OAuth not connected");
  }
  
  const accessToken = await getAccessToken(creds.refresh_token);
  const region = creds.region || "eu-west-1";
  const endpoint = SPAPI_ENDPOINTS[region] || SPAPI_ENDPOINTS["eu-west-1"];
  const marketplaceId = creds.marketplace_id || "A13V1IB3VIYZZH";
  
  const searchParams = new URLSearchParams();
  searchParams.set("MarketplaceIds", marketplaceId);
  searchParams.set("CreatedAfter", createdAfter.toISOString());
  if (createdBefore) searchParams.set("CreatedBefore", createdBefore.toISOString());
  searchParams.set("MaxResultsPerPage", String(BATCH_SIZE_ORDERS));
  if (nextToken) searchParams.set("NextToken", nextToken);
  
  const url = `${endpoint}/orders/v0/orders?${searchParams.toString()}`;
  
  const response = await fetch(url, {
    method: "GET",
    headers: {
      "x-amz-access-token": accessToken,
      "x-amz-date": new Date().toISOString().replace(/[:-]|\.\d{3}/g, ""),
    },
  });
  
  if (response.status === 429) {
    console.log("[Backfill] Rate limited, waiting 5s...");
    await new Promise(r => setTimeout(r, 5000));
    return fetchOrdersByCreationDate(params);
  }
  
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`SP-API error ${response.status}: ${errorText.substring(0, 200)}`);
  }
  
  const data = await response.json();
  return {
    orders: data.payload?.Orders || [],
    nextToken: data.payload?.NextToken,
  };
}

// Fetch items for an order
async function fetchOrderItems(tenantId: string, amazonOrderId: string): Promise<any[]> {
  const creds = await getAmazonTenantCredentials(tenantId);
  if (!creds) return [];
  
  const accessToken = await getAccessToken(creds.refresh_token);
  const region = creds.region || "eu-west-1";
  const endpoint = SPAPI_ENDPOINTS[region] || SPAPI_ENDPOINTS["eu-west-1"];
  
  const url = `${endpoint}/orders/v0/orders/${amazonOrderId}/orderItems`;
  
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          "x-amz-access-token": accessToken,
          "x-amz-date": new Date().toISOString().replace(/[:-]|\.\d{3}/g, ""),
        },
      });
      
      if (response.status === 429) {
        await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
        continue;
      }
      
      if (!response.ok) return [];
      
      const data = await response.json();
      return data.payload?.OrderItems || [];
    } catch {
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  return [];
}

// Upsert order
async function upsertOrder(tenantId: string, amzOrder: any, items: any[]) {
  const totalAmount = amzOrder.OrderTotal ? parseFloat(amzOrder.OrderTotal.Amount) : 0;
  const currency = amzOrder.OrderTotal?.CurrencyCode || "EUR";
  const orderId = `ord_${amzOrder.AmazonOrderId.replace(/[^a-zA-Z0-9]/g, "_")}`;
  
  const existing = await prisma.order.findUnique({
    where: {
      tenantId_marketplace_externalOrderId: {
        tenantId,
        marketplace: MarketplaceType.AMAZON,
        externalOrderId: amzOrder.AmazonOrderId,
      },
    },
  });
  
  if (existing) {
    await prisma.order.update({
      where: { id: existing.id },
      data: {
        orderStatus: mapAmazonStatus(amzOrder.OrderStatus),
        deliveryStatus: mapDeliveryStatus(amzOrder),
        totalAmount,
        carrier: extractCarrier(amzOrder),
        customerName: amzOrder.BuyerInfo?.BuyerName || amzOrder.ShippingAddress?.Name || existing.customerName,
        customerEmail: amzOrder.BuyerInfo?.BuyerEmail || existing.customerEmail,
        updatedAt: new Date(),
      },
    });
  } else {
    await prisma.order.create({
      data: {
        id: orderId,
        tenantId,
        externalOrderId: amzOrder.AmazonOrderId,
        orderRef: `#${amzOrder.AmazonOrderId.substring(amzOrder.AmazonOrderId.length - 6)}`,
        marketplace: MarketplaceType.AMAZON,
        customerName: amzOrder.BuyerInfo?.BuyerName || amzOrder.ShippingAddress?.Name || "Client Amazon",
        customerEmail: amzOrder.BuyerInfo?.BuyerEmail || null,
        orderDate: new Date(amzOrder.PurchaseDate),
        currency,
        totalAmount,
        orderStatus: mapAmazonStatus(amzOrder.OrderStatus),
        deliveryStatus: mapDeliveryStatus(amzOrder),
        items: {
          create: items.map((item, idx) => ({
            id: `itm_${amzOrder.AmazonOrderId}_${item.OrderItemId || item.ASIN}_${idx}`,
            asin: item.ASIN,
            sku: item.SellerSKU || null,
            title: item.Title || item.ASIN,
            quantity: item.QuantityOrdered,
            unitPrice: item.ItemPrice ? parseFloat(item.ItemPrice.Amount) / item.QuantityOrdered : 0,
          })),
        },
      },
    });
  }
}

/**
 * Run initial backfill for a tenant
 * @param tenantId - Tenant to backfill
 * @param days - Number of days to backfill (default 365)
 */
export async function runInitialBackfill(tenantId: string, days: number = DEFAULT_BACKFILL_DAYS): Promise<BackfillResult> {
  const startTime = Date.now();
  console.log(`[Backfill] Starting ${days}-day backfill for tenant ${tenantId}`);
  
  const result: BackfillResult = {
    success: false,
    tenantId,
    daysBackfilled: days,
    ordersProcessed: 0,
    itemsProcessed: 0,
    errors: [],
    durationMs: 0,
  };
  
  try {
    // Mark backfill as in_progress
    await prisma.marketplaceSyncState.updateMany({
      where: { tenantId, type: MarketplaceType.AMAZON },
      data: {
        initialBackfillStatus: "in_progress",
        initialBackfillDays: days,
        updatedAt: new Date(),
      },
    });
    
    const createdAfter = new Date();
    createdAfter.setDate(createdAfter.getDate() - days);
    
    let allOrders: any[] = [];
    let nextToken: string | undefined;
    let maxLastUpdateDate: Date = createdAfter;
    
    // Fetch all orders with pagination
    console.log(`[Backfill] Fetching orders since ${createdAfter.toISOString()}`);
    do {
      const response = await fetchOrdersByCreationDate({
        tenantId,
        createdAfter,
        nextToken,
      });
      
      allOrders = allOrders.concat(response.orders);
      nextToken = response.nextToken;
      
      for (const order of response.orders) {
        const orderDate = new Date(order.LastUpdateDate);
        if (orderDate > maxLastUpdateDate) maxLastUpdateDate = orderDate;
      }
      
      console.log(`[Backfill] Fetched ${allOrders.length} orders so far...`);
      
      if (nextToken) await new Promise(r => setTimeout(r, RATE_LIMIT_DELAY_MS));
    } while (nextToken);
    
    console.log(`[Backfill] Total orders to process: ${allOrders.length}`);
    
    // Process each order
    for (const amzOrder of allOrders) {
      try {
        let items: any[] = [];
        try {
          items = await fetchOrderItems(tenantId, amzOrder.AmazonOrderId);
          result.itemsProcessed += items.length;
          await new Promise(r => setTimeout(r, RATE_LIMIT_DELAY_MS));
        } catch (itemErr) {
          result.errors.push(`Items ${amzOrder.AmazonOrderId}: ${(itemErr as Error).message}`);
        }
        
        await upsertOrder(tenantId, amzOrder, items);
        result.ordersProcessed++;
        
        if (result.ordersProcessed % 50 === 0) {
          console.log(`[Backfill] Processed ${result.ordersProcessed}/${allOrders.length} orders`);
        }
      } catch (orderErr) {
        result.errors.push(`Order ${amzOrder.AmazonOrderId}: ${(orderErr as Error).message}`);
      }
    }
    
    // Mark backfill as success and update cursor
    const newCursor = new Date(maxLastUpdateDate.getTime() + 1000);
    await prisma.marketplaceSyncState.updateMany({
      where: { tenantId, type: MarketplaceType.AMAZON },
      data: {
        initialBackfillStatus: "success",
        initialBackfillDoneAt: new Date(),
        cursor: newCursor.toISOString(),
        lastSuccessAt: new Date(),
        lastError: result.errors.length > 0 ? result.errors.slice(0, 3).join("; ") : null,
        updatedAt: new Date(),
      },
    });
    
    result.success = true;
    result.durationMs = Date.now() - startTime;
    console.log(`[Backfill] SUCCESS: ${result.ordersProcessed} orders, ${result.itemsProcessed} items in ${result.durationMs}ms`);
    
  } catch (err) {
    result.errors.push((err as Error).message);
    result.durationMs = Date.now() - startTime;
    
    // Mark backfill as failed
    await prisma.marketplaceSyncState.updateMany({
      where: { tenantId, type: MarketplaceType.AMAZON },
      data: {
        initialBackfillStatus: "failed",
        lastError: (err as Error).message,
        updatedAt: new Date(),
      },
    });
    
    console.error(`[Backfill] FAILED:`, err);
  }
  
  return result;
}

/**
 * Check if tenant needs initial backfill
 */
export async function needsInitialBackfill(tenantId: string): Promise<boolean> {
  const state = await prisma.marketplaceSyncState.findFirst({
    where: { tenantId, type: MarketplaceType.AMAZON },
  });
  
  // Needs backfill if:
  // 1. No sync state exists yet
  // 2. initialBackfillDoneAt is null AND status is not in_progress
  if (!state) return true;
  if (state.initialBackfillDoneAt) return false;
  if ((state as any).initialBackfillStatus === "in_progress") return false;
  
  return true;
}

/**
 * Get backfill status for a tenant
 */
export async function getBackfillStatus(tenantId: string) {
  const state = await prisma.marketplaceSyncState.findFirst({
    where: { tenantId, type: MarketplaceType.AMAZON },
  });
  
  const ordersCount = await prisma.order.count({ where: { tenantId } });
  
  // Get oldest order date
  const oldestOrder = await prisma.order.findFirst({
    where: { tenantId },
    orderBy: { orderDate: "asc" },
    select: { orderDate: true },
  });
  
  return {
    tenantId,
    initialBackfillDays: (state as any)?.initialBackfillDays || null,
    initialBackfillDoneAt: (state as any)?.initialBackfillDoneAt?.toISOString() || null,
    initialBackfillStatus: (state as any)?.initialBackfillStatus || null,
    ordersCount,
    oldestOrderDate: oldestOrder?.orderDate?.toISOString() || null,
  };
}