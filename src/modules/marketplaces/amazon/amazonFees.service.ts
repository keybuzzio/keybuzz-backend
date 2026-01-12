// src/modules/marketplaces/amazon/amazonFees.service.ts
// PH15-AMAZON-COMMISSION-RATES: Service for Amazon referral fee rates

import { getAccessToken } from "./amazon.tokens";
import { getAmazonTenantCredentials } from "./amazon.vault";

const SPAPI_ENDPOINTS: Record<string, string> = {
  "eu-west-1": "https://sellingpartnerapi-eu.amazon.com",
  "us-east-1": "https://sellingpartnerapi-na.amazon.com",
  "us-west-2": "https://sellingpartnerapi-fe.amazon.com",
};

// Marketplace IDs by country
const MARKETPLACE_IDS: Record<string, string> = {
  FR: "A13V1IB3VIYZZH",
  DE: "A1PA6795UKMFR9",
  IT: "APJ6JRA9NG5V4",
  ES: "A1RKKUPIHCS9HS",
  UK: "A1F83G8C2ARO7P",
  GB: "A1F83G8C2ARO7P",
  NL: "A1805IZSGTT6HS",
  BE: "AMEN7PMS3EDWL",
  PL: "A1C3SOZRARQ6R3",
  SE: "A2NODRKZP88ZB9",
  US: "ATVPDKIKX0DER",
  CA: "A2EUQ1WTGCTBG2",
  MX: "A1AM78C64UM0Y8",
};

// Default referral fee rates by category (fallback)
// Source: Amazon Seller Central fee schedule
const DEFAULT_REFERRAL_RATES: Record<string, number> = {
  "Amazon Device Accessories": 0.45,
  "Automotive": 0.12,
  "Baby Products": 0.08,
  "Beauty": 0.08,
  "Books": 0.15,
  "Camera": 0.08,
  "Cell Phone Devices": 0.08,
  "Clothing & Accessories": 0.17,
  "Computers": 0.08,
  "Consumer Electronics": 0.08,
  "Electronics Accessories": 0.15,
  "Furniture": 0.15,
  "Garden & Outdoor": 0.15,
  "Grocery": 0.08,
  "Health & Personal Care": 0.08,
  "Home": 0.15,
  "Jewelry": 0.20,
  "Kitchen": 0.15,
  "Luggage": 0.15,
  "Music": 0.15,
  "Musical Instruments": 0.15,
  "Office Products": 0.15,
  "Pet Supplies": 0.15,
  "Shoes": 0.15,
  "Software": 0.15,
  "Sports": 0.15,
  "Tools": 0.15,
  "Toys": 0.15,
  "Video Games": 0.15,
  "Watches": 0.15,
  "DEFAULT": 0.15,
};

export interface CommissionRateRequest {
  sku: string;
  ean?: string;
  asin?: string;
  country: string;
  price?: number;
}

export interface CommissionRateResponse {
  sku: string;
  ean?: string;
  country: string;
  rate: number | null;
  source: "spapi" | "fallback" | "error";
  category?: string;
  updated_at: string;
  error?: string;
}

interface FeesEstimateResult {
  Status: string;
  FeesEstimateIdentifier: {
    MarketplaceId: string;
    IdType: string;
    IdValue: string;
    IsAmazonFulfilled: boolean;
    PriceToEstimateFees: {
      ListingPrice: { CurrencyCode: string; Amount: number };
      Shipping?: { CurrencyCode: string; Amount: number };
    };
    SellerInputIdentifier: string;
  };
  FeesEstimate?: {
    TotalFeesEstimate: { CurrencyCode: string; Amount: number };
    FeeDetailList: Array<{
      FeeType: string;
      FeeAmount: { CurrencyCode: string; Amount: number };
      FeePromotion?: { CurrencyCode: string; Amount: number };
      FinalFee: { CurrencyCode: string; Amount: number };
    }>;
  };
  Error?: {
    Type: string;
    Code: string;
    Message: string;
  };
}

/**
 * Get commission rates for a batch of items via SP-API
 */
export async function getCommissionRates(
  tenantId: string,
  items: CommissionRateRequest[]
): Promise<CommissionRateResponse[]> {
  const results: CommissionRateResponse[] = [];
  const now = new Date().toISOString();

  // Get tenant credentials
  const creds = await getAmazonTenantCredentials(tenantId);
  if (!creds || !creds.refresh_token) {
    // Return error for all items if no credentials
    return items.map((item) => ({
      sku: item.sku,
      ean: item.ean,
      country: item.country,
      rate: null,
      source: "error" as const,
      updated_at: now,
      error: "NO_CREDENTIALS",
    }));
  }

  try {
    const accessToken = await getAccessToken(creds.refresh_token);
    const region = creds.region || "eu-west-1";
    const endpoint = SPAPI_ENDPOINTS[region] || SPAPI_ENDPOINTS["eu-west-1"];

    // Group items by country/marketplace
    const itemsByMarketplace = new Map<string, CommissionRateRequest[]>();
    for (const item of items) {
      const marketplaceId = MARKETPLACE_IDS[item.country.toUpperCase()];
      if (!marketplaceId) {
        results.push({
          sku: item.sku,
          ean: item.ean,
          country: item.country,
          rate: null,
          source: "error",
          updated_at: now,
          error: "UNKNOWN_COUNTRY",
        });
        continue;
      }
      const existing = itemsByMarketplace.get(marketplaceId) || [];
      existing.push(item);
      itemsByMarketplace.set(marketplaceId, existing);
    }

    // Process each marketplace batch
    for (const [marketplaceId, marketplaceItems] of itemsByMarketplace) {
      const batchResults = await fetchFeesEstimateBatch(
        endpoint,
        accessToken,
        marketplaceId,
        marketplaceItems
      );
      results.push(...batchResults);
    }

    return results;
  } catch (error) {
    console.error(`[AmazonFees] Error getting commission rates:`, error);
    // Return fallback for all items on error
    return items.map((item) => getFallbackRate(item, now, String(error)));
  }
}

/**
 * Fetch fees estimate for a batch of items from SP-API
 */
async function fetchFeesEstimateBatch(
  endpoint: string,
  accessToken: string,
  marketplaceId: string,
  items: CommissionRateRequest[]
): Promise<CommissionRateResponse[]> {
  const results: CommissionRateResponse[] = [];
  const now = new Date().toISOString();

  // Build request body for GetMyFeesEstimates
  const feesEstimateRequests = items.map((item, index) => {
    const identifier = item.asin || item.ean || item.sku;
    const idType = item.asin ? "ASIN" : "SellerSKU";
    const price = item.price || 19.99; // Default price for estimation

    return {
      FeesEstimateRequest: {
        MarketplaceId: marketplaceId,
        IdType: idType,
        IdValue: identifier,
        IsAmazonFulfilled: false,
        PriceToEstimateFees: {
          ListingPrice: {
            CurrencyCode: getCurrencyForMarketplace(marketplaceId),
            Amount: price,
          },
        },
        Identifier: `${item.sku}_${index}`,
      },
    };
  });

  try {
    // SP-API: POST /products/fees/v0/feesEstimate
    const response = await fetch(
      `${endpoint}/products/fees/v0/feesEstimate`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-amz-access-token": accessToken,
        },
        body: JSON.stringify(feesEstimateRequests),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[AmazonFees] SP-API error: ${response.status} - ${errorText}`);
      // Return fallback for all items
      return items.map((item) =>
        getFallbackRate(item, now, `SPAPI_ERROR_${response.status}`)
      );
    }

    const data = await response.json();
    const feesResults: FeesEstimateResult[] = data || [];

    // Process results
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const feesResult = feesResults[i];

      if (!feesResult || feesResult.Error) {
        results.push(getFallbackRate(item, now, feesResult?.Error?.Code || "NO_RESULT"));
        continue;
      }

      // Extract referral fee rate
      const referralFee = feesResult.FeesEstimate?.FeeDetailList?.find(
        (fee) => fee.FeeType === "ReferralFee"
      );

      if (referralFee) {
        const price = item.price || 19.99;
        const feeAmount = referralFee.FinalFee.Amount;
        const rate = price > 0 ? feeAmount / price : 0;

        results.push({
          sku: item.sku,
          ean: item.ean,
          country: item.country,
          rate: Math.round(rate * 10000) / 10000, // 4 decimal places
          source: "spapi",
          updated_at: now,
        });
      } else {
        results.push(getFallbackRate(item, now, "NO_REFERRAL_FEE"));
      }
    }

    return results;
  } catch (error) {
    console.error(`[AmazonFees] Fetch error:`, error);
    return items.map((item) => getFallbackRate(item, now, String(error)));
  }
}

/**
 * Get fallback rate from default table
 */
function getFallbackRate(
  item: CommissionRateRequest,
  now: string,
  reason: string
): CommissionRateResponse {
  // Use default rate (15%) as fallback
  const defaultRate = DEFAULT_REFERRAL_RATES["DEFAULT"];

  return {
    sku: item.sku,
    ean: item.ean,
    country: item.country,
    rate: defaultRate,
    source: "fallback",
    category: "DEFAULT",
    updated_at: now,
    error: reason,
  };
}

/**
 * Get currency code for marketplace
 */
function getCurrencyForMarketplace(marketplaceId: string): string {
  const currencies: Record<string, string> = {
    A13V1IB3VIYZZH: "EUR", // FR
    A1PA6795UKMFR9: "EUR", // DE
    APJ6JRA9NG5V4: "EUR", // IT
    A1RKKUPIHCS9HS: "EUR", // ES
    A1F83G8C2ARO7P: "GBP", // UK
    A1805IZSGTT6HS: "EUR", // NL
    AMEN7PMS3EDWL: "EUR", // BE
    A1C3SOZRARQ6R3: "PLN", // PL
    A2NODRKZP88ZB9: "SEK", // SE
    ATVPDKIKX0DER: "USD", // US
    A2EUQ1WTGCTBG2: "CAD", // CA
    A1AM78C64UM0Y8: "MXN", // MX
  };
  return currencies[marketplaceId] || "EUR";
}

/**
 * Validate internal API token
 */
export function validateInternalToken(
  providedToken: string | undefined
): boolean {
  const expectedToken = process.env.KEYBUZZ_INTERNAL_TOKEN;
  if (!expectedToken) {
    console.error("[AmazonFees] KEYBUZZ_INTERNAL_TOKEN not configured");
    return false;
  }
  return providedToken === expectedToken;
}
