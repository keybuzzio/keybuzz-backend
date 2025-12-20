/**
 * PH11-06B.3 Outbound Email Service
 * Handles sending emails (SMTP or SES)
 */

import { PrismaClient, OutboundEmailStatus } from "@prisma/client";
import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";

const prisma = new PrismaClient();

export interface SendEmailPayload {
  tenantId: string;
  ticketId: string;
  toAddress: string;
  from?: string;
  subject: string;
  body: string;
}

// SMTP transporter (lazy init)
let smtpTransporter: Transporter | null = null;

function getSmtpTransporter(): Transporter {
  if (!smtpTransporter) {
    smtpTransporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || "localhost",
      port: parseInt(process.env.SMTP_PORT || "587"),
      secure: process.env.SMTP_SECURE === "true",
      auth: process.env.SMTP_USER && process.env.SMTP_PASS ? {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      } : undefined,
    });
  }
  return smtpTransporter;
}

/**
 * Send email (creates record + sends)
 */
export async function sendEmail(payload: SendEmailPayload): Promise<{
  id: string;
  status: OutboundEmailStatus;
  error?: string;
}> {
  const { tenantId, ticketId, toAddress, from, subject, body } = payload;
  const fromAddress = from || process.env.SMTP_FROM || "noreply@keybuzz.io";

  // Create outbound email record
  const outboundEmail = await prisma.outboundEmail.create({
    data: {
      tenantId,
      ticketId,
      toAddress,
      from: fromAddress,
      subject,
      body,
      status: OutboundEmailStatus.PENDING,
    },
  });

  // Try to send
  try {
    const provider = process.env.EMAIL_PROVIDER || "smtp";
    
    if (provider === "ses") {
      await sendViaSES({
        toAddress,
        from: fromAddress,
        subject,
        body,
      });
    } else {
      await sendViaSMTP({
        toAddress,
        from: fromAddress,
        subject,
        body,
      });
    }

    // Mark as sent
    await prisma.outboundEmail.update({
      where: { id: outboundEmail.id },
      data: {
        status: OutboundEmailStatus.SENT,
        sentAt: new Date(),
        provider: provider as any,
      },
    });

    return { id: outboundEmail.id, status: OutboundEmailStatus.SENT };
  } catch (error) {
    const errorMsg = (error as Error).message;
    
    await prisma.outboundEmail.update({
      where: { id: outboundEmail.id },
      data: {
        status: OutboundEmailStatus.FAILED,
        error: errorMsg,
      },
    });

    return { id: outboundEmail.id, status: OutboundEmailStatus.FAILED, error: errorMsg };
  }
}

/**
 * Send via SMTP
 */
async function sendViaSMTP(email: { toAddress: string; from: string; subject: string; body: string }) {
  const transporter = getSmtpTransporter();
  
  await transporter.sendMail({
    to: email.toAddress,
    from: email.from,
    subject: email.subject,
    html: email.body,
  });
}

/**
 * Send via AWS SES
 */
async function sendViaSES(email: { toAddress: string; from: string; subject: string; body: string }) {
  console.log("[OutboundEmail] SES not implemented, falling back to SMTP");
  await sendViaSMTP(email);
}

/**
 * Get outbound email by ID
 */
export async function getOutboundEmail(id: string) {
  return prisma.outboundEmail.findUnique({ where: { id } });
}

/**
 * List outbound emails for ticket
 */
export async function listOutboundEmails(ticketId: string) {
  return prisma.outboundEmail.findMany({
    where: { ticketId },
    orderBy: { createdAt: "desc" },
  });
}

/**
 * Retry failed email
 */
export async function retryEmail(id: string): Promise<{
  success: boolean;
  error?: string;
}> {
  const outboundEmail = await prisma.outboundEmail.findUnique({
    where: { id },
  });

  if (!outboundEmail) {
    return { success: false, error: "Email not found" };
  }

  if (outboundEmail.status !== OutboundEmailStatus.FAILED) {
    return { success: false, error: "Email is not in FAILED status" };
  }

  try {
    await sendViaSMTP({
      toAddress: outboundEmail.toAddress,
      from: outboundEmail.from,
      subject: outboundEmail.subject,
      body: outboundEmail.body,
    });

    await prisma.outboundEmail.update({
      where: { id },
      data: {
        status: OutboundEmailStatus.SENT,
        sentAt: new Date(),
        error: null,
      },
    });

    return { success: true };
  } catch (error) {
    const errorMsg = (error as Error).message;
    
    await prisma.outboundEmail.update({
      where: { id },
      data: { error: errorMsg },
    });

    return { success: false, error: errorMsg };
  }
}
