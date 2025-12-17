/**
 * Inbound Connection Status Calculation
 * PH11-06B.5C
 */

import { prisma } from "../../lib/db";
import { InboundConnectionStatus, InboundValidationStatus } from "@prisma/client";
import { logger } from "../../config/logger";

/**
 * Calculate and update status for an InboundConnection
 */
export async function calculateConnectionStatus(connectionId: string): Promise<InboundConnectionStatus> {
  try {
    const connection = await prisma.inboundConnection.findUnique({
      where: { id: connectionId },
      include: {
        addresses: true,
      },
    });
    
    if (!connection) {
      throw new Error(`Connection ${connectionId} not found`);
    }
    
    // No addresses = DRAFT
    if (!connection.addresses || connection.addresses.length === 0) {
      return InboundConnectionStatus.DRAFT;
    }
    
    const validatedCount = connection.addresses.filter(
      (a) => a.validationStatus === InboundValidationStatus.VALIDATED
    ).length;
    const pendingCount = connection.addresses.filter(
      (a) => a.validationStatus === InboundValidationStatus.PENDING
    ).length;
    const failedCount = connection.addresses.filter(
      (a) => a.validationStatus === InboundValidationStatus.FAILED
    ).length;
    
    // Check if Amazon marketplace connection exists
    const amazonConnection = await prisma.marketplaceConnection.findFirst({
      where: {
        tenantId: connection.tenantId,
        type: connection.marketplace as any,
      },
    });
    
    const amazonConnected = amazonConnection?.status === "CONNECTED";
    
    // Decision tree
    if (failedCount > 0 && validatedCount === 0) {
      return InboundConnectionStatus.ERROR;
    }
    
    if (validatedCount === 0) {
      return InboundConnectionStatus.WAITING_EMAIL;
    }
    
    if (!amazonConnected) {
      return InboundConnectionStatus.WAITING_AMAZON;
    }
    
    if (validatedCount === connection.addresses.length && amazonConnected) {
      return InboundConnectionStatus.READY;
    }
    
    if (validatedCount > 0 && (pendingCount > 0 || failedCount > 0)) {
      return InboundConnectionStatus.DEGRADED;
    }
    
    return InboundConnectionStatus.DEGRADED;
  } catch (error) {
    logger.error(`[InboundStatus] Error calculating status: ${(error as Error).message}`);
    return InboundConnectionStatus.ERROR;
  }
}

/**
 * Update connection status in database
 */
export async function updateConnectionStatus(connectionId: string): Promise<void> {
  const newStatus = await calculateConnectionStatus(connectionId);
  
  await prisma.inboundConnection.update({
    where: { id: connectionId },
    data: { status: newStatus },
  });
  
  logger.info(`[InboundStatus] Updated connection ${connectionId} to ${newStatus}`);
}

/**
 * Get action message for status
 */
export function getStatusActionMessage(status: InboundConnectionStatus): string {
  switch (status) {
    case InboundConnectionStatus.DRAFT:
      return "Configure inbound addresses for your marketplaces";
    case InboundConnectionStatus.WAITING_EMAIL:
      return "Send validation email and forward it from your marketplace account";
    case InboundConnectionStatus.WAITING_AMAZON:
      return "Complete Amazon Marketplace connection to start receiving orders";
    case InboundConnectionStatus.READY:
      return "All systems operational - monitoring active";
    case InboundConnectionStatus.DEGRADED:
      return "Some addresses not validated - partial operation";
    case InboundConnectionStatus.ERROR:
      return "Critical error - check configuration and retry validation";
    default:
      return "Unknown status";
  }
}
