/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable no-undef */
// src/modules/outbound/outboundEmail.service.ts
import { PrismaClient } from '@prisma/client';
import { prisma } from "../../lib/db";
import { OutboundEmailProvider, OutboundEmailStatus } from "@prisma/client";
import nodemailer from "nodemailer";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";

// Vault helper (réutiliser celui d'Amazon si disponible, sinon créer un générique)
import { getVaultSecret, getVaultObject } from "../../lib/vault";

export interface SendEmailPayload {
  tenantId: string;
  ticketId: string;
  to: string;
  from?: string;
  subject: string;
  body: string;
}

export interface SendEmailResult {
  success: boolean;
  provider: OutboundEmailProvider;
  outboundEmailId: string;
  error?: string;
}

/**
 * Send email with SMTP first, fallback to SES
 */
export async function sendEmail(payload: SendEmailPayload): Promise<SendEmailResult> {
  const { tenantId, ticketId, to, subject, body } = payload;
  const from = payload.from || "amazon@inbound.keybuzz.io";

  // Create OutboundEmail record
  const outboundEmail = await prisma.outboundEmail.create({
    data: {
      tenantId,
      ticketId,
      to,
      from,
      subject,
      body,
      status: OutboundEmailStatus.PENDING,
    },
  });

  // Try SMTP first
  try {
    await sendViaSMTP({ to, from, subject, body });

    // Update status
    await prisma.outboundEmail.update({
      where: { id: outboundEmail.id },
      data: {
        status: OutboundEmailStatus.SENT,
        provider: OutboundEmailProvider.SMTP,
        sentAt: new Date(),
      },
    });

    return {
      success: true,
      provider: OutboundEmailProvider.SMTP,
      outboundEmailId: outboundEmail.id,
    };
  } catch (smtpError: any) {
    console.error("[Outbound Email] SMTP failed:", smtpError.message);

    // Fallback to SES
    try {
      await sendViaSES({ to, from, subject, body });

      // Update status
      await prisma.outboundEmail.update({
        where: { id: outboundEmail.id },
        data: {
          status: OutboundEmailStatus.SENT,
          provider: OutboundEmailProvider.SES,
          sentAt: new Date(),
        },
      });

      console.log("[Outbound Email] ✓ Sent via SES fallback");

      return {
        success: true,
        provider: OutboundEmailProvider.SES,
        outboundEmailId: outboundEmail.id,
      };
    } catch (sesError: any) {
      console.error("[Outbound Email] SES failed:", sesError.message);

      // Update status as failed
      await prisma.outboundEmail.update({
        where: { id: outboundEmail.id },
        data: {
          status: OutboundEmailStatus.FAILED,
          error: `SMTP: ${smtpError.message}; SES: ${sesError.message}`,
        },
      });

      return {
        success: false,
        provider: OutboundEmailProvider.SMTP, // tried first
        outboundEmailId: outboundEmail.id,
        error: `Both SMTP and SES failed`,
      };
    }
  }
}

/**
 * Send via SMTP (Postfix mail-core-01)
 */
async function sendViaSMTP(email: { to: string; from: string; subject: string; body: string }) {
  // Get SMTP credentials from Vault
  const smtp = await getVaultObject("smtp");
  const smtpHost = smtp.host || process.env.SMTP_HOST || "10.0.0.160"; // mail-core-01
  const smtpPort = parseInt((smtp.port || process.env.SMTP_PORT || "587").toString());
  const smtpUser = smtp.user;
  const smtpPass = smtp.password;

const transportConfig: any = {
    host: smtpHost,
    port: smtpPort,
    secure: false,
    connectionTimeout: 10000,
    tls: {
      rejectUnauthorized: false, // Accept self-signed cert
    },
  };

  // For port 25 (internal relay), disable TLS completely
  if (smtpPort === 25) {
    transportConfig.ignoreTLS = true;
    delete transportConfig.tls;
  }

  // Only add auth if user/password are provided (skip for internal relay)
  if (smtpUser && smtpPass) {
    transportConfig.auth = {
      user: smtpUser,
      pass: smtpPass,
    };
  }

  const transporter = nodemailer.createTransport(transportConfig);

  await transporter.sendMail({
    from: email.from,
    to: email.to,
    subject: email.subject,
    text: email.body,
  });
}

/**
 * Send via Amazon SES
 */
async function sendViaSES(email: { to: string; from: string; subject: string; body: string }) {
  // Get SES credentials from Vault
  const ses = await getVaultObject("ses");
  const accessKeyId = ses.access_key;
  const secretAccessKey = ses.secret_key;
  const region = ses.region || "eu-west-1";

  const sesClient = new SESClient({
    region,
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
  });

  const command = new SendEmailCommand({
    Source: email.from,
    Destination: {
      ToAddresses: [email.to],
    },
    Message: {
      Subject: {
        Data: email.subject,
        Charset: "UTF-8",
      },
      Body: {
        Text: {
          Data: email.body,
          Charset: "UTF-8",
        },
      },
    },
  });

  await sesClient.send(command);
}

/**
 * Get recent outbound emails for a ticket (for rate limiting)
 */
export async function getRecentOutboundEmails(
  ticketId: string,
  hours: number = 1
): Promise<number> {
  const since = new Date();
  since.setHours(since.getHours() - hours);

  const count = await prisma.outboundEmail.count({
    where: {
      ticketId,
      createdAt: {
        gte: since,
      },
      status: {
        in: [OutboundEmailStatus.SENT, OutboundEmailStatus.PENDING],
      },
    },
  });

  return count;
}

/**
 * Get recent outbound emails for a tenant (for rate limiting)
 */
export async function getRecentTenantOutboundEmails(
  tenantId: string,
  hours: number = 1
): Promise<number> {
  const since = new Date();
  since.setHours(since.getHours() - hours);

  const count = await prisma.outboundEmail.count({
    where: {
      tenantId,
      createdAt: {
        gte: since,
      },
      status: {
        in: [OutboundEmailStatus.SENT, OutboundEmailStatus.PENDING],
      },
    },
  });

  return count;
}



/**
 * PH11-06C: Send outbound email from job worker
 */
export async function sendOutboundEmailFromJob(outboundEmailId: string): Promise<void> {
  const prisma = new PrismaClient();

  // Fetch OutboundEmail record
  const outboundEmail = await prisma.outboundEmail.findUnique({
    where: { id: outboundEmailId },
  });

  if (!outboundEmail) {
    throw new Error(`OutboundEmail ${outboundEmailId} not found`);
  }

  // Send using Nodemailer or SES directly (simplified)
  try {
    // TODO: Implement actual sending logic (SMTP + SES fallback)
    // For now, just mark as SENT
    await prisma.outboundEmail.update({
      where: { id: outboundEmailId },
      data: {
        status: 'SENT',
        provider: 'SMTP',
        sentAt: new Date(),
      },
    });

    console.log(`[Outbound] Email ${outboundEmailId} marked as SENT (TODO: implement actual sending)`);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    await prisma.outboundEmail.update({
      where: { id: outboundEmailId },
      data: {
        status: 'FAILED',
        error: errorMsg,
      },
    });
    throw error;
  }
}
