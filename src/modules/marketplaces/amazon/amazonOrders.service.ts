// src/modules/marketplaces/amazon/amazonOrders.service.ts
// PH15-TRACKING-PROVENANCE-AUDIT-01: Amazon Orders with REAL carrier from SP-API

import { prisma } from "../../../lib/db";
import { getAccessToken } from "./amazon.tokens";
import { getAmazonTenantCredentials } from "./amazon.vault";
import { MarketplaceType, OrderStatus, DeliveryStatus, SavStatus, SlaStatus } from "@prisma/client";
import { getTrackingInfo } from "./carrierTracking.service";

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
  // PH15-TRACKING: Add carrier fields from SP-API
  AutomatedShippingSettings?: {
    AutomatedCarrier?: string;
    AutomatedCarrierName?: string;
    HasAutomatedShippingSettings?: boolean;
  };
  ShipServiceLevel?: string;
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

export async function fetchOrderItems(params: {
  tenantId: string;
  amazonOrderId: string;
}): Promise<AmazonOrderItem[]> {
  const { tenantId, amazonOrderId } = params;
  const creds = await getAmazonTenantCredentials(tenantId);
  if (!creds || !creds.refresh_token) throw new Error("Amazon OAuth not connected");
  const accessToken = await getAccessToken(creds.refresh_token);
  const region = creds.region || "eu-west-1";
  const endpoint = SPAPI_ENDPOINTS[region] || SPAPI_ENDPOINTS["eu-west-1"];
  const url = `${endpoint}/orders/v0/orders/${amazonOrderId}/orderItems`;
  const response = await fetch(url, {
    method: "GET",
    headers: { "x-amz-access-token": accessToken, "x-amz-date": new Date().toISOString().replace(/[:-]|\.\d{3}/g, "") },
  });
  if (!response.ok) throw new Error(`SP-API OrderItems error ${response.status}`);
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
    const creds = await getAmazonTenantCredentials(tenantId);
    if (!creds || !creds.refresh_token) throw new Error("Amazon OAuth not connected - no refresh token");
    const accessToken = await getAccessToken(creds.refresh_token);
    const region = creds.region || "eu-west-1";
    const endpoint = SPAPI_ENDPOINTS[region] || SPAPI_ENDPOINTS["eu-west-1"];
    const marketplaceId = creds.marketplace_id || "A13V1IB3VIYZZH";
    const searchParams = new URLSearchParams();
    searchParams.set("MarketplaceIds", marketplaceId);
    searchParams.set("CreatedAfter", createdAfter.toISOString());
    searchParams.set("MaxResultsPerPage", "100");
    const url = `${endpoint}/orders/v0/orders?${searchParams.toString()}`;
    const response = await fetch(url, { method: "GET", headers: { "x-amz-access-token": accessToken, "x-amz-date": new Date().toISOString().replace(/[:-]|\.\d{3}/g, "") } });
    if (!response.ok) { const errorText = await response.text(); throw new Error(`SP-API Orders error ${response.status}: ${errorText.substring(0, 200)}`); }
    const data = await response.json();
    const orders = data.payload?.Orders || [];
    console.log(`[Orders Backfill] Fetched ${orders.length} orders from Amazon`);
    for (const amzOrder of orders) {
      try {
        let items: AmazonOrderItem[] = [];
        try { items = await fetchOrderItems({ tenantId, amazonOrderId: amzOrder.AmazonOrderId }); await new Promise(r => setTimeout(r, 500)); } catch (itemErr) { console.warn(`[Orders Backfill] Could not fetch items for ${amzOrder.AmazonOrderId}: ${itemErr}`); }
        const totalAmount = amzOrder.OrderTotal ? parseFloat(amzOrder.OrderTotal.Amount) : 0;
        const currency = amzOrder.OrderTotal?.CurrencyCode || "EUR";
        
        // PH15-TRACKING: Extract carrier from AutomatedShippingSettings
        const carrier = extractCarrier(amzOrder);
        // NOTE: TrackingNumber is NOT provided by Amazon Orders API - would need Shipping API or Reports
        
        await prisma.order.upsert({
          where: { tenantId_marketplace_externalOrderId: { tenantId, marketplace: MarketplaceType.AMAZON, externalOrderId: amzOrder.AmazonOrderId } },
          create: {
            id: `ord_${amzOrder.AmazonOrderId.replace(/[^a-zA-Z0-9]/g, "_")}`,
            tenantId, externalOrderId: amzOrder.AmazonOrderId, orderRef: `#${amzOrder.AmazonOrderId.substring(amzOrder.AmazonOrderId.length - 6)}`,
            marketplace: MarketplaceType.AMAZON, customerName: amzOrder.BuyerInfo?.BuyerName || amzOrder.ShippingAddress?.Name || "Client Amazon",
            customerEmail: amzOrder.BuyerInfo?.BuyerEmail || null, orderDate: new Date(amzOrder.PurchaseDate), currency, totalAmount,
            orderStatus: mapAmazonStatus(amzOrder.OrderStatus), deliveryStatus: mapDeliveryStatus(amzOrder),
            carrier: carrier, // Real carrier from SP-API
            trackingCode: null, // Not available via Orders API
            shippingAddress: amzOrder.ShippingAddress ? amzOrder.ShippingAddress : undefined, updatedAt: new Date(),
            items: { create: items.map(item => ({ id: `itm_${amzOrder.AmazonOrderId}_${item.ASIN}`, asin: item.ASIN, sku: item.SellerSKU || null, title: item.Title || item.ASIN, quantity: item.QuantityOrdered, unitPrice: item.ItemPrice ? parseFloat(item.ItemPrice.Amount) / item.QuantityOrdered : 0 })) },
          },
          update: { 
            orderStatus: mapAmazonStatus(amzOrder.OrderStatus), 
            deliveryStatus: mapDeliveryStatus(amzOrder), 
            totalAmount, 
            carrier: carrier, // Update carrier on sync
            updatedAt: new Date() 
          },
        });
        imported++;
        if (onProgress) onProgress(imported);
      } catch (orderErr) { errors.push(`Order ${amzOrder.AmazonOrderId}: ${(orderErr as Error).message}`); console.error(`[Orders Backfill] ${amzOrder.AmazonOrderId}:`, orderErr); }
    }
  } catch (fetchErr) { errors.push(`Fetch error: ${(fetchErr as Error).message}`); console.error(`[Orders Backfill] Fetch error:`, fetchErr); }
  console.log(`[Orders Backfill] Completed: ${imported} imported, ${errors.length} errors`);
  return { imported, errors };
}

// Query params interface
interface OrdersQueryParams {
  tenantId: string;
  limit?: number;
  offset?: number;
  search?: string;
  status?: string;
  dateFrom?: Date;
  dateTo?: Date;
}

// Get orders with search and filters - includes tracking URL
export async function getOrdersForTenant(params: OrdersQueryParams): Promise<any[]> {
  const { tenantId, limit = 50, offset = 0, search, status, dateFrom, dateTo } = params;
  const where: any = { tenantId };
  if (search) { where.externalOrderId = { contains: search, mode: "insensitive" }; }
  if (status) { where.orderStatus = status.toUpperCase(); }
  if (dateFrom || dateTo) { where.orderDate = {}; if (dateFrom) where.orderDate.gte = dateFrom; if (dateTo) where.orderDate.lte = dateTo; }
  const orders = await prisma.order.findMany({ where, orderBy: { orderDate: "desc" }, take: limit, skip: offset, include: { items: true } });
  
  return orders.map(o => {
    const tracking = getTrackingInfo(o.carrier, o.trackingCode);
    return {
      id: o.id, ref: o.orderRef, externalOrderId: o.externalOrderId, date: o.orderDate.toISOString(),
      channel: o.marketplace.toLowerCase(), customer: { name: o.customerName, email: o.customerEmail },
      products: o.items.map(i => ({ name: i.title, qty: i.quantity, price: i.unitPrice, sku: i.sku, asin: i.asin })),
      orderStatus: o.orderStatus.toLowerCase(), deliveryStatus: o.deliveryStatus.toLowerCase().replace(/_/g, "_"),
      savStatus: o.savStatus.toLowerCase(), slaStatus: o.slaStatus.toLowerCase(),
      carrier: tracking.carrierDisplayName, trackingCode: tracking.trackingNumber, trackingUrl: tracking.trackingUrl,
      totalAmount: o.totalAmount, currency: o.currency, conversationCount: 0,
    };
  });
}

// Count orders with filters
export async function countOrdersForTenant(params: Omit<OrdersQueryParams, "limit" | "offset">): Promise<number> {
  const { tenantId, search, status, dateFrom, dateTo } = params;
  const where: any = { tenantId };
  if (search) { where.externalOrderId = { contains: search, mode: "insensitive" }; }
  if (status) { where.orderStatus = status.toUpperCase(); }
  if (dateFrom || dateTo) { where.orderDate = {}; if (dateFrom) where.orderDate.gte = dateFrom; if (dateTo) where.orderDate.lte = dateTo; }
  return prisma.order.count({ where });
}

// Get single order by ID - includes tracking URL
export async function getOrderById(params: { tenantId: string; orderId: string }): Promise<any | null> {
  const { tenantId, orderId } = params;
  const order = await prisma.order.findFirst({ where: { tenantId, OR: [{ id: orderId }, { externalOrderId: orderId }] }, include: { items: true } });
  if (!order) return null;
  
  const address = order.shippingAddress as any;
  const formattedAddress = address ? `${address.AddressLine1 || ""}, ${address.City || ""} ${address.PostalCode || ""}, ${address.CountryCode || ""}` : null;
  const tracking = getTrackingInfo(order.carrier, order.trackingCode);
  
  return {
    id: order.id, ref: order.orderRef, externalOrderId: order.externalOrderId, date: order.orderDate.toISOString(),
    channel: order.marketplace.toLowerCase(), status: order.orderStatus.toLowerCase(),
    deliveryStatus: order.deliveryStatus.toLowerCase().replace(/_/g, "_"), savStatus: order.savStatus.toLowerCase(), slaStatus: order.slaStatus.toLowerCase(),
    carrier: tracking.carrierDisplayName, trackingCode: tracking.trackingNumber, trackingUrl: tracking.trackingUrl,
    customer: { name: order.customerName || "Client Amazon (PII masque)", email: order.customerEmail || null, phone: null, address: formattedAddress },
    products: order.items.map(i => ({ name: i.title || i.asin || "Produit", quantity: i.quantity, price: i.unitPrice, sku: i.sku, asin: i.asin })),
    totalAmount: order.totalAmount, currency: order.currency,
    timeline: [{ date: order.orderDate.toISOString(), event: "Commande passee", status: "done" }, { date: order.updatedAt.toISOString(), event: "Derniere mise a jour", status: "current" }],
    conversations: [],
  };
}