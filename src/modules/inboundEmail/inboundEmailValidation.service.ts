/**
 * Service validation email (self-test loop)
 * PH11-06B.5G.1 - Standardized format
 */

import { prisma } from '../../lib/db';
import { logger } from '../../config/logger';
import { enqueueJob } from '../jobs/jobs.service';
import { JobType } from '@prisma/client';

/**
 * Envoie email de validation vers l'adresse inbound elle-même (self-test)
 * Format standardisé:
 * - subject: "KeyBuzz Validation <token>"
 * - from: "validator@inbound.keybuzz.io"
 * - to: amazon.<tenant>.<country>.<token>@inbound.keybuzz.io
 */
export async function sendValidationEmail(connectionId: string, country?: string) {
  const connection = await prisma.inboundConnection.findUnique({
    where: { id: connectionId },
    include: { addresses: true },
  });

  if (!connection) {
    throw new Error('Connection not found');
  }

  const addressesToValidate = country
    ? connection.addresses.filter(a => a.country === country)
    : connection.addresses.filter(a => a.validationStatus !== 'VALIDATED');

  const results = [];

  for (const address of addressesToValidate) {
    // Format standardisé: subject = "KeyBuzz Validation <token>"
    const subject = `KeyBuzz Validation ${address.token}`;
    const body = `Validation self-test\nToken: ${address.token}\nAddress: ${address.emailAddress}`;

    // Enqueue outbound email job
    const jobId = await enqueueJob({
      type: JobType.OUTBOUND_EMAIL_SEND,
      tenantId: connection.tenantId,
      payload: {
        to: address.emailAddress,
        from: 'validator@inbound.keybuzz.io',
        subject,
        body,
      },
    });

    logger.info(`[Validation] Queued email to ${address.emailAddress} (job: ${jobId})`);

    results.push({
      addressId: address.id,
      emailAddress: address.emailAddress,
      jobId,
      status: 'queued',
    });
  }

  return {
    connectionId,
    sent: results.length,
    results,
  };
}

/**
 * Régénère le token pour une adresse
 */
export async function regenerateToken(addressId: string) {
  const address = await prisma.inboundAddress.findUnique({
    where: { id: addressId },
  });

  if (!address) {
    throw new Error('Address not found');
  }

  const { generateToken, buildInboundAddress } = require('./inboundEmailAddress.service');

  const newToken = generateToken();
  const newEmailAddress = buildInboundAddress({
    marketplace: address.marketplace,
    tenantId: address.tenantId,
    country: address.country,
    token: newToken,
  });

  const updated = await prisma.inboundAddress.update({
    where: { id: addressId },
    data: {
      token: newToken,
      emailAddress: newEmailAddress,
      validationStatus: 'PENDING',
      lastError: null,
    },
  });

  logger.info(`[Validation] Token regenerated for ${newEmailAddress}`);

  return updated;
}
