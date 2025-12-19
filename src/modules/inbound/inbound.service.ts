// src/modules/inbound/inbound.service.ts
// Service traitement email inbound avec validation
// PH11-06B.5A + PH11-06B.6 (Amazon detection)

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
  const match = subject.match(/KeyBuzz Validation (.+)/i);
  if (match) {
    return { isValidation: true, token: match[1].trim() };
  }
  return { isValidation: false };
}

/**
 * Détecte si un email a été forwardé par Amazon (vrai forward, pas self-test)
 * PH11-06B.6.2 - Heuristiques robustes
 */
export function isAmazonForwardedEmail(params: {
  from?: string;
  messageId?: string;
  headers?: Record<string, string>;
  rawEmail?: string;
  returnPath?: string;
  sender?: string;
}): boolean {
  const { from, messageId, headers, rawEmail, returnPath, sender } = params;
  
  // Log détection Amazon (pour debug)
  const logData: any = {
    from: from?.substring(0, 60) || 'N/A',
    messageId: messageId?.substring(0, 80) || 'N/A',
    returnPath: returnPath?.substring(0, 50) || 'N/A',
    sender: sender?.substring(0, 50) || 'N/A',
  };
  
  logger.info('[AmazonDetection] Checking:', JSON.stringify(logData));

  // Critère 1: From contient @marketplace.amazon.* ou @amazon.*
  if (from) {
    const fromLower = from.toLowerCase();
    if (fromLower.includes('@marketplace.amazon.') || fromLower.includes('@amazon.')) {
      logger.info('[AmazonDetection] ✅ Match: From contains @amazon.*');
      return true;
    }
  }

  // Critère 2: messageId se termine par @eu-west-1.amazonses.com ou similaire
  if (messageId) {
    const msgIdLower = messageId.toLowerCase();
    if (msgIdLower.includes('@') && msgIdLower.includes('amazonses.com')) {
      logger.info('[AmazonDetection] ✅ Match: messageId contains amazonses.com');
      return true;
    }
  }

  // Critère 3: Return-Path ou Sender contient amazon
  if (returnPath) {
    const rpLower = returnPath.toLowerCase();
    if (rpLower.includes('@amazon.') || rpLower.includes('amazonses.com')) {
      logger.info('[AmazonDetection] ✅ Match: Return-Path contains amazon');
      return true;
    }
  }

  if (sender) {
    const senderLower = sender.toLowerCase();
    if (senderLower.includes('@amazon.') || senderLower.includes('amazonses.com')) {
      logger.info('[AmazonDetection] ✅ Match: Sender contains amazon');
      return true;
    }
  }

  // Critère 4: Headers typiques Amazon (x-amazon-*, x-amz-*, x-ses-*)
  if (headers) {
    const headerKeys = Object.keys(headers);
    const amazonHeaders = headerKeys.filter(k => {
      const kLower = k.toLowerCase();
      return kLower.startsWith('x-amazon-') || 
             kLower.startsWith('x-amz-') || 
             kLower.startsWith('x-ses-');
    });
    
    if (amazonHeaders.length > 0) {
      logger.info('[AmazonDetection] ✅ Match: Amazon headers found:', amazonHeaders.join(','));
      return true;
    }
  }

  // Critère 5: Raw email contient amazon.com, amazonses.com, amazonmail.com
  if (rawEmail) {
    const rawLower = rawEmail.toLowerCase();
    if (rawLower.includes('amazon.com') || 
        rawLower.includes('amazonses.com') || 
        rawLower.includes('amazonmail.com')) {
      logger.info('[AmazonDetection] ✅ Match: Raw email contains amazon domain');
      return true;
    }
  }

  logger.info('[AmazonDetection] ❌ No match - not an Amazon forward');
  return false;
}

/**
 * Met à jour marketplaceStatus si email Amazon détecté
 * PH11-06B.6.2
 */
export async function updateMarketplaceStatusIfAmazon(params: {
  tenantId: string;
  marketplace: string;
  country: string;
  from: string;
  messageId: string;
  headers?: Record<string, string>;
  rawEmail?: string;
}): Promise<boolean> {
  const { tenantId, marketplace, country, from, messageId, headers, rawEmail } = params;

  const isAmazon = isAmazonForwardedEmail({
    from,
    messageId,
    headers,
    rawEmail,
  });

  if (isAmazon) {
    logger.info(`[AmazonDetection] Updating marketplaceStatus to VALIDATED for ${tenantId}/${marketplace}/${country}`);
    
    await prisma.inboundAddress.updateMany({
      where: {
        tenantId,
        marketplace: marketplace.toUpperCase() as any,
        country: country.toUpperCase(),
      },
      data: {
        marketplaceStatus: 'VALIDATED',
        pipelineStatus: 'VALIDATED',
      },
    });

    return true;
  }

  return false;
}

/**
 * Traite un email de validation : met à jour pipelineStatus
 */
export async function processValidationEmail(params: {
  to: string;
  subject: string;
  from: string;
  messageId: string;
  headers?: Record<string, string>;
  rawEmail?: string;
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
        marketplace: parsed.marketplace.toUpperCase() as any,
        country: parsed.country.toUpperCase(),
      },
    },
  });

  if (!address) {
    logger.warn(`[Validation] Address not found: ${to}`);
    return { validated: false, error: 'Address not found' };
  }

  // Marquer pipelineStatus comme VALIDATED
  await prisma.inboundAddress.update({
    where: { id: address.id },
    data: {
      pipelineStatus: 'VALIDATED',
      validationStatus: 'VALIDATED',
      lastInboundAt: new Date(),
      lastInboundMessageId: messageId,
      lastError: null,
    },
  });

  logger.info(`[Validation] Address ${to} pipelineStatus marked as VALIDATED`);

  return { validated: true, addressId: address.id };
}
