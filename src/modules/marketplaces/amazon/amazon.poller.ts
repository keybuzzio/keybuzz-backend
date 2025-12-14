// src/modules/marketplaces/amazon/amazon.poller.ts

import { prisma } from "../../../lib/db";
import { createAmazonClient } from "./amazon.client";
import {
  ensureAmazonConnection,
  upsertExternalMessage,
  mapExternalMessageToTicket,
} from "./amazon.service";
import { MarketplaceType } from "@prisma/client";

/**
 * Poll Amazon messages for a single tenant
 */
export async function pollAmazonForTenant(tenantId: string): Promise<void> {
  console.log(`[Amazon Poller] Starting poll for tenant: ${tenantId}`);

  try {
    // 1. Ensure connection exists
    const connection = await ensureAmazonConnection(tenantId);

    if (connection.status !== "CONNECTED") {
      console.log(
        `[Amazon Poller] Connection not CONNECTED for tenant ${tenantId}, skipping`
      );
      return;
    }

    // 2. Get or create sync state
    let syncState = await prisma.marketplaceSyncState.findFirst({
      where: {
        tenantId,
        connectionId: connection.id,
        type: MarketplaceType.AMAZON,
      },
    });

    if (!syncState) {
      syncState = await prisma.marketplaceSyncState.create({
        data: {
          tenantId,
          connectionId: connection.id,
          type: MarketplaceType.AMAZON,
        },
      });
    }

    // 3. Fetch messages from Amazon (mock or real)
    const client = createAmazonClient();
    const result = await client.fetchInboundMessages({
      since: syncState.lastSuccessAt || undefined,
      cursor: syncState.cursor || undefined,
    });

    console.log(
      `[Amazon Poller] Fetched ${result.messages.length} messages for tenant ${tenantId}`
    );

    // 4. Process each message
    for (const message of result.messages) {
      try {
        // Upsert ExternalMessage (idempotent)
        const externalMessage = await upsertExternalMessage(
          tenantId,
          connection.id,
          message
        );

        // Map to Ticket + TicketMessage (idempotent)
        await mapExternalMessageToTicket(
          tenantId,
          externalMessage,
          message.body,
          message.subject
        );
      } catch (err) {
        console.error(
          `[Amazon Poller] Error processing message ${message.externalId}:`,
          err
        );
        // Continue with next message
      }
    }

    // 5. Update sync state
    await prisma.marketplaceSyncState.update({
      where: { id: syncState.id },
      data: {
        cursor: result.nextCursor || syncState.cursor,
        lastPolledAt: new Date(),
        lastSuccessAt: new Date(),
        lastError: null,
      },
    });

    // Update connection lastSyncAt
    await prisma.marketplaceConnection.update({
      where: { id: connection.id },
      data: {
        lastSyncAt: new Date(),
        lastError: null,
      },
    });

    console.log(`[Amazon Poller] Poll completed for tenant: ${tenantId}`);
  } catch (error) {
    console.error(
      `[Amazon Poller] Error polling tenant ${tenantId}:`,
      error
    );

    // Update connection with error
    const connection = await prisma.marketplaceConnection.findFirst({
      where: { tenantId, type: MarketplaceType.AMAZON },
    });

    if (connection) {
      await prisma.marketplaceConnection.update({
        where: { id: connection.id },
        data: {
          lastError: (error as Error).message,
        },
      });
    }

    throw error;
  }
}

/**
 * Poll Amazon for all tenants with active connections
 */
export async function pollAmazonForAllTenants(): Promise<void> {
  console.log("[Amazon Poller] Starting poll for all tenants");

  // Get all tenants with CONNECTED Amazon connections
  const connections = await prisma.marketplaceConnection.findMany({
    where: {
      type: MarketplaceType.AMAZON,
      status: {
        in: ["CONNECTED", "PENDING"], // PENDING for dev mock
      },
    },
    select: {
      tenantId: true,
    },
    distinct: ["tenantId"],
  });

  console.log(
    `[Amazon Poller] Found ${connections.length} tenants with Amazon connections`
  );

  for (const { tenantId } of connections) {
    try {
      await pollAmazonForTenant(tenantId);
    } catch (err) {
      console.error(
        `[Amazon Poller] Failed to poll tenant ${tenantId}, continuing...`,
        err
      );
      // Continue with next tenant
    }
  }

  console.log("[Amazon Poller] Poll completed for all tenants");
}

