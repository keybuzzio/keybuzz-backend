// src/modules/marketplaces/amazon/amazonOrdersSync.service.ts
// PH15-AMAZON-ORDERS-SYNC-01: Incremental sync for Amazon Orders

import { prisma } from "../../../lib/db";
import { getAccessToken } from "./amazon.tokens";
import { getAmazonTenantCredentials } from "./amazon.vault";
import { MarketplaceType, OrderStatus, DeliveryStatus } from "@prisma/client";

const SPAPI_ENDPOINTS: Record<string, string> = {
  "eu-west-1": "https://sellingpartnerapi-eu.amazon.com",
  "us-east-1": "https://sellingpartnerapi-na.amazon.com",
  "us-west-2": "https://sellingpartnerapi-fe.amazon.com",
};

const RATE_LIMIT_DELAY_MS = 500; // 500ms between API calls

interface AmazonOrder {
  AmazonOrderId: string;
  PurchaseDate: string;
  LastUpdateDate: string;
  OrderStatus: string;
  FulfillmentChannel: string;
  OrderTotal?: { Amount: string; CurrencyCode: string };
  BuyerInfo?: { BuyerEmail?: string; BuyerName?: string };
  ShippingAddress?: { Name?: string; AddressLine1?: string; City?: string; PostalCode?: string; CountryCode?: string };
  NumberOfItemsShipped?: number;
  NumberOfItemsUnshipped?: number;
  // PH15-TRACKING: Carrier from SP-API
  AutomatedShippingSettings?: {
    AutomatedCarrier?: string;
    AutomatedCarrierName?: string;
    HasAutomatedShippingSettings?: boolean;
  };
}

interface AmazonOrderItem {
  OrderItemId: string;
  ASIN: string;
  SellerSKU?: string;
  Title?: string;
  QuantityOrdered: number;
  ItemPrice?: { Amount: string; CurrencyCode: string };
}

interface SyncResult {
  success: boolean;
  ordersProcessed: number;
  itemsProcessed: number;
  errors: string[];
  lastUpdatedAfter: string | null;
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

function mapDeliveryStatus(order: AmazonOrder): DeliveryStatus {
  if (order.NumberOfItemsShipped && order.NumberOfItemsShipped > 0) {
    if (order.NumberOfItemsUnshipped && order.NumberOfItemsUnshipped > 0) {
      return "SHIPPED";
    }
    return "IN_TRANSIT";
  }
  return "PREPARING";
}
// PH15-TRACKING: Extract carrier from AutomatedShippingSettings
function extractCarrier(order: AmazonOrder): string | null {
  if (order.AutomatedShippingSettings?.AutomatedCarrierName) {
    return order.AutomatedShippingSettings.AutomatedCarrierName;
  }
  if (order.AutomatedShippingSettings?.AutomatedCarrier) {
    return order.AutomatedShippingSettings.AutomatedCarrier;
  }
  return null;
}


// Get or create sync state for a tenant
async function getOrCreateSyncState(tenantId: string) {
  let state = await prisma.marketplaceSyncState.findFirst({
    where: { tenantId, type: MarketplaceType.AMAZON },
  });
  
  if (!state) {
    // Create initial sync state - default to 7 days ago
    const defaultLastUpdated = new Date();
    defaultLastUpdated.setDate(defaultLastUpdated.getDate() - 7);
    
    state = await prisma.marketplaceSyncState.create({
      data: {
        id: `sync_amazon_${tenantId}`,
        connectionId: `conn_amazon_${tenantId}`,
        tenantId,
        type: MarketplaceType.AMAZON,
        cursor: defaultLastUpdated.toISOString(), // Use cursor as lastUpdatedAfter
        lastPolledAt: null,
        lastSuccessAt: null,
        lastError: null,
      },
    });
  }
  
  return state;
}

// Update sync state after successful/failed sync
async function updateSyncState(tenantId: string, updates: {
  cursor?: string;
  lastPolledAt?: Date;
  lastSuccessAt?: Date;
  lastError?: string | null;
}) {
  await prisma.marketplaceSyncState.updateMany({
    where: { tenantId, type: MarketplaceType.AMAZON },
    data: {
      ...updates,
      updatedAt: new Date(),
    },
  });
}

// Fetch orders from Amazon with LastUpdatedAfter (delta sync)
async function fetchOrdersDelta(params: {
  tenantId: string;
  lastUpdatedAfter: Date;
  nextToken?: string;
}): Promise<{ orders: AmazonOrder[]; nextToken?: string }> {
  const { tenantId, lastUpdatedAfter, nextToken } = params;
  
  const creds = await getAmazonTenantCredentials(tenantId);
  if (!creds || !creds.refresh_token) {
    throw new Error("Amazon OAuth not connected - no refresh token");
  }
  
  const accessToken = await getAccessToken(creds.refresh_token);
  const region = creds.region || "eu-west-1";
  const endpoint = SPAPI_ENDPOINTS[region] || SPAPI_ENDPOINTS["eu-west-1"];
  const marketplaceId = creds.marketplace_id || "A13V1IB3VIYZZH";
  
  const searchParams = new URLSearchParams();
  searchParams.set("MarketplaceIds", marketplaceId);
  searchParams.set("LastUpdatedAfter", lastUpdatedAfter.toISOString());
  searchParams.set("MaxResultsPerPage", "100");
  if (nextToken) searchParams.set("NextToken", nextToken);
  
  const url = `${endpoint}/orders/v0/orders?${searchParams.toString()}`;
  
  console.log(`[Orders Delta] Fetching: lastUpdatedAfter=${lastUpdatedAfter.toISOString()}`);
  
  const response = await fetch(url, {
    method: "GET",
    headers: {
      "x-amz-access-token": accessToken,
      "x-amz-date": new Date().toISOString().replace(/[:-]|\.\d{3}/g, ""),
    },
  });
  
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

// Fetch items for a specific order
async function fetchOrderItemsWithRetry(params: {
  tenantId: string;
  amazonOrderId: string;
  retries?: number;
}): Promise<AmazonOrderItem[]> {
  const { tenantId, amazonOrderId, retries = 3 } = params;
  
  const creds = await getAmazonTenantCredentials(tenantId);
  if (!creds || !creds.refresh_token) {
    throw new Error("Amazon OAuth not connected");
  }
  
  const accessToken = await getAccessToken(creds.refresh_token);
  const region = creds.region || "eu-west-1";
  const endpoint = SPAPI_ENDPOINTS[region] || SPAPI_ENDPOINTS["eu-west-1"];
  
  let allItems: AmazonOrderItem[] = [];
  let nextToken: string | undefined;
  
  do {
    const url = nextToken 
      ? `${endpoint}/orders/v0/orders/${amazonOrderId}/orderItems?NextToken=${encodeURIComponent(nextToken)}`
      : `${endpoint}/orders/v0/orders/${amazonOrderId}/orderItems`;
    
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const response = await fetch(url, {
          method: "GET",
          headers: {
            "x-amz-access-token": accessToken,
            "x-amz-date": new Date().toISOString().replace(/[:-]|\.\d{3}/g, ""),
          },
        });
        
        if (response.status === 429) {
          // Rate limited - wait and retry
          console.log(`[OrderItems] Rate limited for ${amazonOrderId}, waiting...`);
          await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
          continue;
        }
        
        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`SP-API error ${response.status}: ${errorText.substring(0, 100)}`);
        }
        
        const data = await response.json();
        const items = data.payload?.OrderItems || [];
        allItems = allItems.concat(items);
        nextToken = data.payload?.NextToken;
        lastError = null;
        break;
      } catch (err) {
        lastError = err as Error;
        if (attempt < retries - 1) {
          await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
        }
      }
    }
    
    if (lastError) throw lastError;
    
    // Rate limit between pages
    if (nextToken) await new Promise(r => setTimeout(r, RATE_LIMIT_DELAY_MS));
    
  } while (nextToken);
  
  return allItems;
}

// Upsert order and its items
async function upsertOrderWithItems(tenantId: string, amzOrder: AmazonOrder, items: AmazonOrderItem[]) {
  const totalAmount = amzOrder.OrderTotal ? parseFloat(amzOrder.OrderTotal.Amount) : 0;
  const currency = amzOrder.OrderTotal?.CurrencyCode || "EUR";
  const orderId = `ord_${amzOrder.AmazonOrderId.replace(/[^a-zA-Z0-9]/g, "_")}`;
  
  // Check if order exists
  const existing = await prisma.order.findUnique({
    where: {
      tenantId_marketplace_externalOrderId: {
        tenantId,
        marketplace: MarketplaceType.AMAZON,
        externalOrderId: amzOrder.AmazonOrderId,
      },
    },
    include: { items: true },
  });
  
  if (existing) {
    // Update existing order
    await prisma.order.update({
      where: { id: existing.id },
      data: {
        orderStatus: mapAmazonStatus(amzOrder.OrderStatus),
        deliveryStatus: mapDeliveryStatus(amzOrder),
        totalAmount,
        carrier: extractCarrier(amzOrder),
        customerName: amzOrder.BuyerInfo?.BuyerName || amzOrder.ShippingAddress?.Name || existing.customerName,
        customerEmail: amzOrder.BuyerInfo?.BuyerEmail || existing.customerEmail,
        shippingAddress: amzOrder.ShippingAddress ? amzOrder.ShippingAddress as any : undefined,
        updatedAt: new Date(),
      },
    });
    
    // Upsert items (delete old and create new for simplicity)
    if (items.length > 0) {
      await prisma.orderItem.deleteMany({ where: { orderId: existing.id } });
      await prisma.orderItem.createMany({
        data: items.map((item, idx) => ({
          id: `itm_${amzOrder.AmazonOrderId}_${item.OrderItemId || item.ASIN}_${idx}`,
          orderId: existing.id,
          asin: item.ASIN,
          sku: item.SellerSKU || null,
          title: item.Title || item.ASIN,
          quantity: item.QuantityOrdered,
          unitPrice: item.ItemPrice && item.QuantityOrdered > 0 ? parseFloat(item.ItemPrice.Amount) / item.QuantityOrdered : 0,
        })),
      });
    }
  } else {
    // Create new order with items
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
        shippingAddress: amzOrder.ShippingAddress || undefined,
        items: {
          create: items.map((item, idx) => ({
            id: `itm_${amzOrder.AmazonOrderId}_${item.OrderItemId || item.ASIN}_${idx}`,
            asin: item.ASIN,
            sku: item.SellerSKU || null,
            title: item.Title || item.ASIN,
            quantity: item.QuantityOrdered,
            unitPrice: item.ItemPrice && item.QuantityOrdered > 0 ? parseFloat(item.ItemPrice.Amount) / item.QuantityOrdered : 0,
          })),
        },
      },
    });
  }
}

// Main delta sync function
export async function runOrdersDeltaSync(tenantId: string): Promise<SyncResult> {
  console.log(`[Orders Sync] Starting delta sync for tenant ${tenantId}`);
  
  const result: SyncResult = {
    success: false,
    ordersProcessed: 0,
    itemsProcessed: 0,
    errors: [],
    lastUpdatedAfter: null,
  };
  
  try {
    // Get sync state
    const syncState = await getOrCreateSyncState(tenantId);
    const lastUpdatedAfter = syncState.cursor 
      ? new Date(syncState.cursor)
      : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000); // Default 7 days ago
    
    result.lastUpdatedAfter = lastUpdatedAfter.toISOString();
    
    await updateSyncState(tenantId, { lastPolledAt: new Date() });
    
    // Fetch all orders with pagination
    let allOrders: AmazonOrder[] = [];
    let nextToken: string | undefined;
    let maxLastUpdateDate: Date = lastUpdatedAfter;
    
    do {
      const response = await fetchOrdersDelta({ tenantId, lastUpdatedAfter, nextToken });
      allOrders = allOrders.concat(response.orders);
      nextToken = response.nextToken;
      
      // Track max LastUpdateDate
      for (const order of response.orders) {
        const orderDate = new Date(order.LastUpdateDate);
        if (orderDate > maxLastUpdateDate) {
          maxLastUpdateDate = orderDate;
        }
      }
      
      // Rate limit between pages
      if (nextToken) await new Promise(r => setTimeout(r, RATE_LIMIT_DELAY_MS));
      
    } while (nextToken);
    
    console.log(`[Orders Sync] Fetched ${allOrders.length} orders to process`);
    
    // Process each order
    for (const amzOrder of allOrders) {
      try {
        // Fetch items for this order
        let items: AmazonOrderItem[] = [];
        try {
          items = await fetchOrderItemsWithRetry({ tenantId, amazonOrderId: amzOrder.AmazonOrderId });
          result.itemsProcessed += items.length;
          await new Promise(r => setTimeout(r, RATE_LIMIT_DELAY_MS));
        } catch (itemErr) {
          result.errors.push(`Items ${amzOrder.AmazonOrderId}: ${(itemErr as Error).message}`);
        }
        
        // Upsert order with items
        await upsertOrderWithItems(tenantId, amzOrder, items);
        result.ordersProcessed++;
        
      } catch (orderErr) {
        result.errors.push(`Order ${amzOrder.AmazonOrderId}: ${(orderErr as Error).message}`);
      }
    }
    
    // Update sync state with new cursor (max LastUpdateDate)
    // Add 1 second to avoid re-processing the same order
    const newCursor = new Date(maxLastUpdateDate.getTime() + 1000);
    await updateSyncState(tenantId, {
      cursor: newCursor.toISOString(),
      lastSuccessAt: new Date(),
      lastError: result.errors.length > 0 ? result.errors.slice(0, 3).join("; ") : null,
    });
    
    result.success = true;
    console.log(`[Orders Sync] Completed: ${result.ordersProcessed} orders, ${result.itemsProcessed} items, ${result.errors.length} errors`);
    
  } catch (err) {
    const errorMsg = (err as Error).message;
    result.errors.push(errorMsg);
    await updateSyncState(tenantId, { lastError: errorMsg });
    console.error(`[Orders Sync] Failed:`, err);
  }
  
  return result;
}

// Get sync status for a tenant
export async function getSyncStatus(tenantId: string) {
  const syncState = await prisma.marketplaceSyncState.findFirst({
    where: { tenantId, type: MarketplaceType.AMAZON },
  });
  
  const ordersCount = await prisma.order.count({ where: { tenantId } });
  const itemsCount = await prisma.orderItem.count({
    where: { order: { tenantId } },
  });
  
  return {
    tenantId,
    marketplace: "AMAZON",
    syncState: syncState ? {
      lastUpdatedAfter: syncState.cursor,
      lastPolledAt: syncState.lastPolledAt?.toISOString() || null,
      lastSuccessAt: syncState.lastSuccessAt?.toISOString() || null,
      lastError: syncState.lastError,
    } : null,
    counts: {
      orders: ordersCount,
      items: itemsCount,
    },
  };
}

// Sync items for orders that are missing items
export async function syncMissingItems(tenantId: string): Promise<{ processed: number; errors: string[] }> {
  console.log(`[Items Sync] Syncing missing items for tenant ${tenantId}`);
  
  // Find orders with no items
  const ordersWithoutItems = await prisma.order.findMany({
    where: {
      tenantId,
      items: { none: {} },
    },
    select: { id: true, externalOrderId: true },
    take: 50, // Batch size
  });
  
  console.log(`[Items Sync] Found ${ordersWithoutItems.length} orders without items`);
  
  let processed = 0;
  const errors: string[] = [];
  
  for (const order of ordersWithoutItems) {
    try {
      const items = await fetchOrderItemsWithRetry({ tenantId, amazonOrderId: order.externalOrderId });
      
      if (items.length > 0) {
        await prisma.orderItem.createMany({
          data: items.map((item, idx) => ({
            id: `itm_${order.externalOrderId}_${item.OrderItemId || item.ASIN}_${idx}`,
            orderId: order.id,
            asin: item.ASIN,
            sku: item.SellerSKU || null,
            title: item.Title || item.ASIN,
            quantity: item.QuantityOrdered,
            unitPrice: item.ItemPrice && item.QuantityOrdered > 0 ? parseFloat(item.ItemPrice.Amount) / item.QuantityOrdered : 0,
          })),
          skipDuplicates: true,
        });
        processed++;
      }
      
      await new Promise(r => setTimeout(r, RATE_LIMIT_DELAY_MS));
      
    } catch (err) {
      errors.push(`${order.externalOrderId}: ${(err as Error).message}`);
    }
  }
  
  console.log(`[Items Sync] Completed: ${processed} orders updated, ${errors.length} errors`);
  return { processed, errors };
}