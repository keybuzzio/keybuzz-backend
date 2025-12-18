/**
 * Service traitement email inbound avec validation
 * PH11-06B.5A
 */

import { prisma } from '../../lib/db';
import { logger } from '../../config/logger';

/**
 * Parse adresse inbound canonique
 * Format: <marketplace>.<tenantId>.<country>.<token>@inbound.keybuzz.io
 * ou legacy: <marketplace>.<tenantId>@inbound.keybuzz.io
 */
export function parseInboundAddress(to: string): {
  marketplace?: string;
  tenantId?: string;
  country?: string;
  token?: string;
  isCanonical: boolean;
} {
  // Nouveau format canonique: marketplace.tenantId.country.token@inbound.keybuzz.io
  const canonicalMatch = to.match(/^([^.]+)\.([^.]+)\.([^.]+)\.([^@]+)@inbound\.keybuzz\.io$/i);
  if (canonicalMatch) {
    const [, marketplace, tenantId, country, token] = canonicalMatch;
    return { marketplace, tenantId, country, token, isCanonical: true };
  }

  // Legacy format: marketplace.tenantId@inbound.keybuzz.io
  const legacyMatch = to.match(/^([^.]+)\.([^@]+)@inbound\.keybuzz\.io$/i);
  if (legacyMatch) {
    const [, marketplace, tenantId] = legacyMatch;
    return { marketplace, tenantId, isCanonical: false };
  }

  return { isCanonical: false };
}

/**
 * Détecte si un email est un email de validation
 */
export function isValidationEmail(subject: string): { isValidation: boolean; token?: string } {
  const match = subject.match(/KeyBuzz Validation .+ .+ ([a-z0-9]{4,8})/i);
  if (match) {
    return { isValidation: true, token: match[1] };
  }
  return { isValidation: false };
}

/**
 * Traite un email de validation : marque l'adresse comme VALIDATED
 */
export async function processValidationEmail(params: {
  to: string;
  subject: string;
  from: string;
  messageId: string;
}): Promise<{ validated: boolean; addressId?: string; error?: string }> {
  const { to, subject, messageId } = params;

  const { isValidation, token } = isValidationEmail(subject);
  if (!isValidation || !token) {
    return { validated: false };
  }

  const parsed = parseInboundAddress(to);
  if (!parsed.isCanonical || !parsed.tenantId || !parsed.marketplace || !parsed.country || !parsed.token) {
    return { validated: false, error: 'Invalid address format' };
  }

  // Vérifier que le token du subject correspond au token de l'adresse
  if (parsed.token.toLowerCase() !== token.toLowerCase()) {
    logger.warn(`[Validation] Token mismatch: subject=${token}, address=${parsed.token}`);
    return { validated: false, error: 'Token mismatch' };
  }

  // Récupérer l'adresse
  const address = await prisma.inboundAddress.findUnique({
    where: {
      tenantId_marketplace_country: {
        tenantId: parsed.tenantId,
        marketplace: parsed.marketplace.toUpperCase(),
        country: parsed.country.toUpperCase(),
      },
    },
  });

  if (!address) {
    logger.warn(`[Validation] Address not found: ${to}`);
    return { validated: false, error: 'Address not found' };
  }

  // Marquer comme VALIDATED
  await prisma.inboundAddress.update({
    where: { id: address.id },
    data: {
      validationStatus: 'VALIDATED',
      lastInboundAt: new Date(),
      lastInboundMessageId: messageId,
      lastError: null,
    },
  });

  logger.info(`[Validation] Address ${to} marked as VALIDATED`);

  return { validated: true, addressId: address.id };
}
