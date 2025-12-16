/**
 * Service génération adresses inbound canoniques
 * PH11-06B.5A
 */

import { prisma } from '../../lib/db';
import { logger } from '../../config/logger';

/**
 * Format canonique: <marketplace>.<tenantId>.<country>.<token>@inbound.keybuzz.io
 */
export function buildInboundAddress(params: {
  marketplace: string;
  tenantId: string;
  country: string;
  token: string;
}): string {
  const { marketplace, tenantId, country, token } = params;
  return `${marketplace.toLowerCase()}.${tenantId}.${country.toLowerCase()}.${token}@inbound.keybuzz.io`;
}

/**
 * Génère un token alphanumérique sécurisé (6 chars par défaut)
 */
export function generateToken(length: number = 6): string {
  const charset = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let token = '';
  for (let i = 0; i < length; i++) {
    token += charset.charAt(Math.floor(Math.random() * charset.length));
  }
  return token;
}

/**
 * Ensure InboundConnection + InboundAddress existent pour un tenant/marketplace
 */
export async function ensureInboundConnection(params: {
  tenantId: string;
  marketplace: string;
  countries: string[];
}) {
  const { tenantId, marketplace, countries } = params;

  logger.info(`[InboundEmail] Ensuring connection ${tenantId}/${marketplace}`);

  // Upsert connection
  const connection = await prisma.inboundConnection.upsert({
    where: {
      tenantId_marketplace: { tenantId, marketplace },
    },
    create: {
      tenantId,
      marketplace,
      countries,
      status: 'CONNECTED',
    },
    update: {
      countries,
      updatedAt: new Date(),
    },
  });

  // Upsert addresses par country
  for (const country of countries) {
    const existing = await prisma.inboundAddress.findUnique({
      where: {
        tenantId_marketplace_country: { tenantId, marketplace, country },
      },
    });

    if (!existing) {
      const token = generateToken();
      const emailAddress = buildInboundAddress({ marketplace, tenantId, country, token });

      await prisma.inboundAddress.create({
        data: {
          connectionId: connection.id,
          tenantId,
          marketplace,
          country,
          token,
          emailAddress,
          validationStatus: 'PENDING',
        },
      });

      logger.info(`[InboundEmail] Created address: ${emailAddress}`);
    }
  }

  return connection;
}
