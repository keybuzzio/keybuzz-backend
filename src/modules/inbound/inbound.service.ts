<<<<<<< HEAD
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

/**
 * Détecte si un email provient réellement d'Amazon (forward)
 * Heuristiques:
 * - From: finit par @amazon.* OU contient @marketplace.amazon.*
 * - Headers typiques Amazon (x-amazon- / x-amz- / x-ses-)
 * - Received: contient amazon.com / amazonses.com / amazonmail.com
 * - Return-Path / Sender est amazon.*
 */
export function isAmazonForwardedEmail(
  from: string,
  headers: Record<string, string> = {},
  rawEmail?: string
): boolean {
  // 1. Vérifier From
  const fromLower = from.toLowerCase();
  if (fromLower.includes('@amazon.') || fromLower.includes('@marketplace.amazon.')) {
    return true;
  }

  // 2. Vérifier headers typiques Amazon
  const headerKeys = Object.keys(headers).map(k => k.toLowerCase());
  for (const key of headerKeys) {
    if (key.startsWith('x-amazon-') || key.startsWith('x-amz-') || key.startsWith('x-ses-')) {
      return true;
    }
  }

  // 3. Vérifier Received headers
  const receivedHeaders = [
    headers['received'],
    headers['Received'],
    ...Object.entries(headers)
      .filter(([k]) => k.toLowerCase() === 'received')
      .map(([, v]) => v)
  ].filter(Boolean);

  for (const received of receivedHeaders) {
    const receivedLower = received.toLowerCase();
    if (receivedLower.includes('amazon.com') || receivedLower.includes('amazonses.com') || receivedLower.includes('amazonmail.com')) {
      return true;
    }
  }

  // 4. Vérifier Return-Path et Sender
  const returnPath = (headers['return-path'] || headers['Return-Path'] || '').toLowerCase();
  const sender = (headers['sender'] || headers['Sender'] || '').toLowerCase();
  if (returnPath.includes('amazon.') || sender.includes('amazon.')) {
    return true;
  }

  // 5. Vérifier dans rawEmail si disponible
  if (rawEmail) {
    const rawLower = rawEmail.toLowerCase();
    if (rawLower.includes('amazon.com') || rawLower.includes('amazonses.com') || rawLower.includes('amazonmail.com')) {
      return true;
    }
  }

  return false;
}

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
=======
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
  // Format: KeyBuzz Validation <token>
  const match = subject.match(/KeyBuzz Validation (.+)/i);
  if (match) {
    return { isValidation: true, token: match[1].trim() };
  }
  return { isValidation: false };
}

/**
 * Détecte si un email a été forwardé par Amazon (vrai forward, pas self-test)
 * Heuristique basée sur headers, From, Return-Path, Received, etc.
 * PH11-06B.6 - Amélioration avec logs détaillés
 */
export function isAmazonForwardedEmail(
  rawEmail: string,
  headers: Record<string, string>,
  from?: string,
  returnPath?: string,
  sender?: string
): boolean {
  // Log détection Amazon (sans secrets)
  const logData: any = {
    from: from?.substring(0, 50) || 'N/A',
    returnPath: returnPath?.substring(0, 50) || 'N/A',
    sender: sender?.substring(0, 50) || 'N/A',
    headerKeys: Object.keys(headers || {}).filter(k => {
      const kLower = k.toLowerCase();
      return kLower.includes('amazon') || kLower.includes('amz') || kLower.includes('ses');
    }).join(','),
    receivedDomains: (rawEmail || '').match(/Received:\s*from\s+[^\s]+/gi)?.map(r => r.substring(0, 100)).join('|') || 'N/A'
  };
  
  logger.info('[AmazonDetection] Checking:', JSON.stringify(logData));

  // Critère 1: From se termine par @amazon.* ou contient @marketplace.amazon.*
  if (from) {
    const fromLower = from.toLowerCase();
    if (fromLower.includes('@amazon.') || fromLower.includes('@marketplace.amazon.')) {
      logger.info('[AmazonDetection] Match: From contains @amazon.*');
      return true;
    }
  }

  // Critère 2: Return-Path ou Sender est amazon.*
  if (returnPath) {
    const rpLower = returnPath.toLowerCase();
    if (rpLower.includes('@amazon.') || rpLower.includes('amazonses.com')) {
      logger.info('[AmazonDetection] Match: Return-Path contains amazon.*');
      return true;
    }
  }

  if (sender) {
    const senderLower = sender.toLowerCase();
    if (senderLower.includes('@amazon.') || senderLower.includes('amazonses.com')) {
      logger.info('[AmazonDetection] Match: Sender contains amazon.*');
      return true;
    }
  }

  // Critère 3: Headers typiques Amazon (x-amazon-*, x-amz-*, x-ses-*)
  const headerKeys = Object.keys(headers || {});
  const amazonHeaders = headerKeys.filter(k => {
    const kLower = k.toLowerCase();
    return kLower.startsWith('x-amazon-') || 
           kLower.startsWith('x-amz-') || 
           kLower.startsWith('x-ses-');
  });
  
  if (amazonHeaders.length > 0) {
    logger.info('[AmazonDetection] Match: Amazon headers found:', amazonHeaders.join(','));
    return true;
  }

  // Critère 4: Received contient amazon.com, amazonses.com, amazonmail.com
  if (rawEmail) {
    const receivedLower = rawEmail.toLowerCase();
    if (receivedLower.includes('amazon.com') || 
        receivedLower.includes('amazonses.com') || 
        receivedLower.includes('amazonmail.com')) {
      logger.info('[AmazonDetection] Match: Received contains amazon domain');
      return true;
    }
  }

  logger.info('[AmazonDetection] No match - not an Amazon forward');
  return false;
}

/**
 * Traite un email de validation : met à jour pipelineStatus et marketplaceStatus
 * PH11-06B.6 - Split validation en 2 niveaux
 */
export async function processValidationEmail(params: {
  to: string;
  subject: string;
  from: string;
  messageId: string;
  headers?: Record<string, string>;
  rawEmail?: string;
  returnPath?: string;
  sender?: string;
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

  // Détecter si c'est un vrai forward Amazon
  const isAmazonForward = isAmazonForwardedEmail(
    params.rawEmail || '',
    params.headers || {},
    params.from,
    params.returnPath,
    params.sender
  );

  // Mettre à jour pipelineStatus (toujours VALIDATED pour self-test)
  // et marketplaceStatus (VALIDATED seulement si Amazon forward détecté)
  const updateData: any = {
    pipelineStatus: 'VALIDATED',
    marketplaceStatus: isAmazonForward ? 'VALIDATED' : 'PENDING',
    lastInboundAt: new Date(),
    lastInboundMessageId: messageId,
    lastError: null,
  };

  // Garder validationStatus pour compatibilité (point vers marketplaceStatus)
  updateData.validationStatus = updateData.marketplaceStatus;

  await prisma.inboundAddress.update({
    where: { id: address.id },
    data: updateData,
  });

  if (isAmazonForward) {
    logger.info(`[Validation] Address ${to} marked as VALIDATED (Pipeline + Amazon Forward)`);
  } else {
    logger.info(`[Validation] Address ${to} marked as Pipeline VALIDATED, Amazon Forward PENDING`);
  }

  return { validated: true, addressId: address.id };
}
>>>>>>> c71de79 (feat(PH11-06B.6): add isAmazonForwardedEmail with detailed logs + split pipeline/marketplace validation)
