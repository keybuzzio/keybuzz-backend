// src/modules/marketplaces/amazon/amazonOrderImport.service.ts
// PH24.4-ORDER-PANEL-IMPORT-ONDEMAND-01: Import single order on-demand

import { prisma } from "../../../lib/db";
import { getAccessToken } from "./amazon.tokens";
import { getAmazonTenantCredentials } from "./amazon.vault";
import { MarketplaceType, OrderStatus, DeliveryStatus } from "@prisma/client";

const SPAPI_ENDPOINTS: Record<string, string> = {
  "eu-west-1": "https://sellingpartnerapi-eu.amazon.com",
  "us-east-1": "https://sellingpartnerapi-na.amazon.com",
  "us-west-2": "https://sellingpartnerapi-fe.amazon.com",
};

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
  AutomatedShippingSettings?: {
    AutomatedCarrier?: string;
    AutomatedCarrierName?: string;
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

interface ImportResult {
  success: boolean;
  orderId?: string;
  externalOrderId?: string;
  imported: boolean;
  error?: string;
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

function extractCarrier(order: AmazonOrder): string | null {
  if (order.AutomatedShippingSettings?.AutomatedCarrierName) {
    return order.AutomatedShippingSettings.AutomatedCarrierName;
  }
  if (order.AutomatedShippingSettings?.AutomatedCarrier) {
    return order.AutomatedShippingSettings.AutomatedCarrier;
  }
  return null;
}

/**
 * Fetch a single order from Amazon SP-API by order ID
 */
async function fetchSingleOrder(tenantId: string, orderRef: string): Promise<AmazonOrder | null> {
  const creds = await getAmazonTenantCredentials(tenantId);
  if (!creds || !creds.refresh_token) {
    throw new Error("Amazon OAuth not connected - no refresh token");
  }

  const accessToken = await getAccessToken(creds.refresh_token);
  const region = creds.region || "eu-west-1";
  const endpoint = SPAPI_ENDPOINTS[region] || SPAPI_ENDPOINTS["eu-west-1"];

  const url = `${endpoint}/orders/v0/orders/${encodeURIComponent(orderRef)}`;
  
  console.log(`[Order Import] Fetching order: ${orderRef}`);
  
  const response = await fetch(url, {
    method: "GET",
    headers: {
      "x-amz-access-token": accessToken,
      "x-amz-date": new Date().toISOString().replace(/[:-]|\.\d{3}/g, ""),
    },
  });

  if (response.status === 404) {
    console.log(`[Order Import] Order not found: ${orderRef}`);
    return null;
  }

  if (response.status === 429) {
    throw new Error("Amazon API rate limited - please retry in a few seconds");
  }

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Amazon API error ${response.status}: ${errorText.substring(0, 200)}`);
  }

  const data = await response.json();
  return data.payload || null;
}

/**
 * Fetch order items from Amazon SP-API
 */
async function fetchOrderItems(tenantId: string, orderRef: string): Promise<AmazonOrderItem[]> {
  const creds = await getAmazonTenantCredentials(tenantId);
  if (!creds || !creds.refresh_token) {
    throw new Error("Amazon OAuth not connected");
  }

  const accessToken = await getAccessToken(creds.refresh_token);
  const region = creds.region || "eu-west-1";
  const endpoint = SPAPI_ENDPOINTS[region] || SPAPI_ENDPOINTS["eu-west-1"];

  const url = `${endpoint}/orders/v0/orders/${encodeURIComponent(orderRef)}/orderItems`;
  
  console.log(`[Order Import] Fetching items for: ${orderRef}`);
  
  const response = await fetch(url, {
    method: "GET",
    headers: {
      "x-amz-access-token": accessToken,
      "x-amz-date": new Date().toISOString().replace(/[:-]|\.\d{3}/g, ""),
    },
  });

  if (response.status === 429) {
    throw new Error("Amazon API rate limited - please retry in a few seconds");
  }

  if (!response.ok) {
    const errorText = await response.text();
    console.warn(`[Order Import] Items fetch error: ${response.status}`);
    return []; // Return empty items, don't fail the whole import
  }

  const data = await response.json();
  return data.payload?.OrderItems || [];
}

/**
 * Upsert order and items into database
 */
async function upsertOrder(tenantId: string, amzOrder: AmazonOrder, items: AmazonOrderItem[]): Promise<string> {
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

    return existing.id;
  } else {
    // Create new order
    const newOrder = await prisma.order.create({
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

    return newOrder.id;
  }
}

/**
 * Import a single order by its Amazon order reference
 */
export async function importSingleOrder(tenantId: string, orderRef: string): Promise<ImportResult> {
  console.log(`[Order Import] Starting import for tenant=${tenantId}, orderRef=${orderRef}`);

  try {
    // Check if Amazon is connected
    const connection = await prisma.marketplaceConnection.findFirst({
      where: {
        tenantId,
        type: MarketplaceType.AMAZON,
        status: "CONNECTED",
      },
    });

    if (!connection) {
      return {
        success: false,
        imported: false,
        error: "Amazon not connected for this tenant",
      };
    }

    // Fetch order from Amazon
    const amzOrder = await fetchSingleOrder(tenantId, orderRef);
    if (!amzOrder) {
      return {
        success: false,
        imported: false,
        error: "Order not found in Amazon",
      };
    }

    // Fetch order items
    const items = await fetchOrderItems(tenantId, orderRef);

    // Upsert to database
    const orderId = await upsertOrder(tenantId, amzOrder, items);

    console.log(`[Order Import] Success: orderId=${orderId}, items=${items.length}`);

    return {
      success: true,
      orderId,
      externalOrderId: amzOrder.AmazonOrderId,
      imported: true,
    };
  } catch (err: any) {
    console.error(`[Order Import] Error:`, err.message);
    return {
      success: false,
      imported: false,
      error: err.message,
    };
  }
}