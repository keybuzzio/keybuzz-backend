// src/modules/marketplaces/amazon/amazonOrders.service.ts
// PH15-AMAZON-BACKFILL-ORDERS-01: Amazon Orders SP-API service

import { prisma } from "../../../lib/db";
import { getAccessToken } from "./amazon.tokens";
import { getAmazonTenantCredentials } from "./amazon.vault";
import { MarketplaceType, OrderStatus, DeliveryStatus, SavStatus, SlaStatus } from "@prisma/client";

const SPAPI_ENDPOINTS: Record<string, string> = {
  "eu-west-1": "https://sellingpartnerapi-eu.amazon.com",
  "us-east-1": "https://sellingpartnerapi-na.amazon.com",
  "us-west-2": "https://sellingpartnerapi-fe.amazon.com",
};

interface AmazonOrder {
  AmazonOrderId: string;
  PurchaseDate: string;
  OrderStatus: string;
  FulfillmentChannel: string;
  OrderTotal?: { Amount: string; CurrencyCode: string };
  BuyerInfo?: { BuyerEmail?: string; BuyerName?: string };
  ShippingAddress?: { Name?: string; AddressLine1?: string; City?: string; PostalCode?: string; CountryCode?: string };
  NumberOfItemsShipped?: number;
  NumberOfItemsUnshipped?: number;
}

interface AmazonOrderItem {
  ASIN: string;
  SellerSKU?: string;
  Title?: string;
  QuantityOrdered: number;
  ItemPrice?: { Amount: string; CurrencyCode: string };
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

export async function fetchAmazonOrders(params: {
  tenantId: string;
  createdAfter?: Date;
  createdBefore?: Date;
  maxResults?: number;
}): Promise<AmazonOrder[]> {
  const { tenantId, createdAfter, createdBefore, maxResults = 100 } = params;
  
  console.log(`[SP-API Orders] Fetching orders for tenant ${tenantId}`);
  
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
  if (createdAfter) searchParams.set("CreatedAfter", createdAfter.toISOString());
  if (createdBefore) searchParams.set("CreatedBefore", createdBefore.toISOString());
  searchParams.set("MaxResultsPerPage", String(Math.min(maxResults, 100)));
  
  const url = `${endpoint}/orders/v0/orders?${searchParams.toString()}`;
  
  const response = await fetch(url, {
    method: "GET",
    headers: {
      "x-amz-access-token": accessToken,
      "x-amz-date": new Date().toISOString().replace(/[:-]|\.\d{3}/g, ""),
    },
  });
  
  if (!response.ok) {
    const errorText = await response.text();
    console.error(`[SP-API Orders] Error ${response.status}: ${errorText}`);
    throw new Error(`SP-API Orders error ${response.status}: ${errorText.substring(0, 200)}`);
  }
  
  const data = await response.json();
  return data.payload?.Orders || [];
}

export async function fetchOrderItems(params: {
  tenantId: string;
  amazonOrderId: string;
}): Promise<AmazonOrderItem[]> {
  const { tenantId, amazonOrderId } = params;
  
  const creds = await getAmazonTenantCredentials(tenantId);
  if (!creds || !creds.refresh_token) {
    throw new Error("Amazon OAuth not connected");
  }
  
  const accessToken = await getAccessToken(creds.refresh_token);
  const region = creds.region || "eu-west-1";
  const endpoint = SPAPI_ENDPOINTS[region] || SPAPI_ENDPOINTS["eu-west-1"];
  
  const url = `${endpoint}/orders/v0/orders/${amazonOrderId}/orderItems`;
  
  const response = await fetch(url, {
    method: "GET",
    headers: {
      "x-amz-access-token": accessToken,
      "x-amz-date": new Date().toISOString().replace(/[:-]|\.\d{3}/g, ""),
    },
  });
  
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`SP-API OrderItems error ${response.status}: ${errorText.substring(0, 200)}`);
  }
  
  const data = await response.json();
  return data.payload?.OrderItems || [];
}

export async function backfillAmazonOrders(params: {
  tenantId: string;
  days: number;
  onProgress?: (count: number) => void;
}): Promise<{ imported: number; errors: string[] }> {
  const { tenantId, days, onProgress } = params;
  
  const createdAfter = new Date();
  createdAfter.setDate(createdAfter.getDate() - days);
  
  console.log(`[Orders Backfill] Starting ${days}-day backfill for tenant ${tenantId}`);
  
  let imported = 0;
  const errors: string[] = [];
  
  try {
    const orders = await fetchAmazonOrders({ tenantId, createdAfter });
    console.log(`[Orders Backfill] Fetched ${orders.length} orders from Amazon`);
    
    for (const amzOrder of orders) {
      try {
        // Fetch order items
        let items: AmazonOrderItem[] = [];
        try {
          items = await fetchOrderItems({ tenantId, amazonOrderId: amzOrder.AmazonOrderId });
          await new Promise(r => setTimeout(r, 500)); // Rate limit
        } catch (itemErr) {
          console.warn(`[Orders Backfill] Could not fetch items for ${amzOrder.AmazonOrderId}: ${itemErr}`);
        }
        
        const totalAmount = amzOrder.OrderTotal ? parseFloat(amzOrder.OrderTotal.Amount) : 0;
        const currency = amzOrder.OrderTotal?.CurrencyCode || "EUR";
        
        // Upsert order
        await prisma.order.upsert({
          where: {
            tenantId_marketplace_externalOrderId: {
              tenantId,
              marketplace: MarketplaceType.AMAZON,
              externalOrderId: amzOrder.AmazonOrderId,
            },
          },
          create: {
            id: `ord_${amzOrder.AmazonOrderId.replace(/[^a-zA-Z0-9]/g, "_")}`,
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
            shippingAddress: amzOrder.ShippingAddress ? amzOrder.ShippingAddress : undefined,
            updatedAt: new Date(),
            items: {
              create: items.map(item => ({
                id: `itm_${amzOrder.AmazonOrderId}_${item.ASIN}`,
                asin: item.ASIN,
                sku: item.SellerSKU || null,
                title: item.Title || item.ASIN,
                quantity: item.QuantityOrdered,
                unitPrice: item.ItemPrice ? parseFloat(item.ItemPrice.Amount) / item.QuantityOrdered : 0,
              })),
            },
          },
          update: {
            orderStatus: mapAmazonStatus(amzOrder.OrderStatus),
            deliveryStatus: mapDeliveryStatus(amzOrder),
            totalAmount,
            updatedAt: new Date(),
          },
        });
        
        imported++;
        if (onProgress) onProgress(imported);
        
      } catch (orderErr) {
        const errMsg = `Order ${amzOrder.AmazonOrderId}: ${(orderErr as Error).message}`;
        errors.push(errMsg);
        console.error(`[Orders Backfill] ${errMsg}`);
      }
    }
    
  } catch (fetchErr) {
    errors.push(`Fetch error: ${(fetchErr as Error).message}`);
    console.error(`[Orders Backfill] Fetch error:`, fetchErr);
  }
  
  console.log(`[Orders Backfill] Completed: ${imported} imported, ${errors.length} errors`);
  return { imported, errors };
}

export async function getOrdersForTenant(params: {
  tenantId: string;
  limit?: number;
  offset?: number;
}): Promise<any[]> {
  const { tenantId, limit = 50, offset = 0 } = params;
  
  const orders = await prisma.order.findMany({
    where: { tenantId },
    orderBy: { orderDate: "desc" },
    take: limit,
    skip: offset,
    include: { items: true },
  });
  
  return orders.map(o => ({
    id: o.id,
    ref: o.orderRef,
    date: o.orderDate.toISOString(),
    channel: o.marketplace.toLowerCase(),
    customer: { name: o.customerName, email: o.customerEmail },
    products: o.items.map(i => ({ name: i.title, qty: i.quantity, price: i.unitPrice })),
    orderStatus: o.orderStatus.toLowerCase(),
    deliveryStatus: o.deliveryStatus.toLowerCase().replace(/_/g, "_"),
    savStatus: o.savStatus.toLowerCase(),
    slaStatus: o.slaStatus.toLowerCase(),
    carrier: o.carrier,
    trackingCode: o.trackingCode,
    totalAmount: o.totalAmount,
    conversationCount: 0,
  }));
}