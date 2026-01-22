// PH15-INBOUND-TO-CONVERSATION-01 + PH-MVP-ATTACHMENTS-RENDER-01
import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { prisma } from "../../lib/db";
import { MarketplaceType } from "@prisma/client";
import { parseInboundAddress, processValidationEmail, updateMarketplaceStatusIfAmazon } from "../inbound/inbound.service";
import { createInboxConversation } from "./inboxConversation.service";
import { parseMimeEmail, storeAttachments } from "./attachmentParser.service";

async function inboundEmailWebhookPlugin(server: FastifyInstance, _opts: FastifyPluginOptions) {
  /**
   * POST /inbound-email
   * Dedicated webhook endpoint for Postfix (no JWT, internal key auth only)
   */
  server.post("/inbound-email", async (request, reply) => {
    // Internal key authentication
    const internalKey = String(request.headers["x-internal-key"] ?? "");
    const expectedKey = process.env.INBOUND_WEBHOOK_KEY ?? "";
    
    if (!expectedKey) {
      console.error("[Webhook] INBOUND_WEBHOOK_KEY not configured");
      return reply.code(500).send({ error: "Server configuration error" });
    }
    
    if (!internalKey || internalKey !== expectedKey) {
      console.warn("[Webhook] Unauthorized attempt:", { 
        hasKey: !!internalKey,
        keyMatch: false 
      });
      return reply.code(401).send({ error: "Unauthorized" });
    }

    try {
      const payload = request.body as {
        from: string;
        to: string;
        subject?: string;
        messageId: string;
        receivedAt: string;
        body: string;
        headers?: Record<string, string>;
      };

      console.log("[Webhook] Received inbound email:", {
        from: payload.from,
        to: payload.to,
        messageId: payload.messageId,
        payloadKeys: Object.keys(payload),
        textField: (payload as any).text?.substring(0, 100),
        htmlField: (payload as any).html?.substring(0, 100),
        bodyLength: payload.body?.length,
      });

      // Parse recipient first
      const parsed = parseInboundAddress(payload.to);
      if (!parsed.marketplace || !parsed.tenantId) {
        console.warn("[Webhook] Invalid recipient format:", payload.to);
        return reply.code(400).send({ error: "Invalid recipient format" });
      }

      const { marketplace, tenantId } = parsed;
      const country = (parsed.country || 'FR').toUpperCase();

      if (marketplace.toLowerCase() !== "amazon") {
        return reply.code(400).send({ error: "Unsupported marketplace" });
      }

      // Check if validation email
      const validationResult = await processValidationEmail({
        to: payload.to,
        subject: payload.subject || "",
        from: payload.from,
        messageId: payload.messageId,
        headers: payload.headers || {},
        rawEmail: payload.body || "",
      });

      if (validationResult.validated) {
        console.log(`[Webhook] Validation email processed: ${payload.messageId}`);
        return reply.send({
          success: true,
          validation: true,
          addressId: validationResult.addressId,
          messageId: payload.messageId,
        });
      }

      // For non-validation emails, check if it's an Amazon forward
      const amazonUpdated = await updateMarketplaceStatusIfAmazon({
        tenantId,
        marketplace,
        country,
        from: payload.from,
        messageId: payload.messageId,
        headers: payload.headers || {},
        rawEmail: payload.body || "",
      });

      if (amazonUpdated) {
        console.log(`[Webhook] Amazon forward detected, marketplaceStatus updated for ${tenantId}/${country}`);
      }

      // Idempotence check for ExternalMessage
      const existing = await prisma.externalMessage.findUnique({
        where: {
          type_connectionId_externalId: {
            type: MarketplaceType.AMAZON,
            connectionId: tenantId,
            externalId: payload.messageId,
          },
        },
      });

      if (existing) {
        console.log("[Webhook] Already processed:", payload.messageId);
        return reply.send({ success: true, message: "Already processed", amazonForward: amazonUpdated });
      }

      // ===== PH-MVP-ATTACHMENTS-RENDER-01: Parse MIME email =====
      // DEBUG: Log raw body structure in detail
      console.log('[Webhook DEBUG] Raw body length:', payload.body?.length);
      
      // Find boundaries and show structure
      const rawBody = payload.body || '';
      const boundaryMatch = rawBody.match(/(------=_Part_[^\n\r]+)/);
      if (boundaryMatch) {
        const boundary = boundaryMatch[1];
        console.log('[Webhook DEBUG] Boundary found:', boundary);
        const parts = rawBody.split(boundary);
        console.log('[Webhook DEBUG] Number of parts:', parts.length);
        for (let i = 0; i < parts.length && i < 4; i++) {
          console.log(`[Webhook DEBUG] Part ${i} (first 300 chars):`, parts[i].substring(0, 300).replace(/\n/g, '\\n'));
        }
      } else {
        console.log('[Webhook DEBUG] No boundary found, first 1000 chars:', rawBody.substring(0, 1000));
      }
      
      const parsedEmail = parseMimeEmail(payload.body);
      const cleanBody = parsedEmail.textBody || payload.body;
      
      console.log(`[Webhook] Parsed email: textBody=${parsedEmail.textBody.length} chars, attachments=${parsedEmail.attachments.length}`);

      // Create ExternalMessage (backend DB)
      const externalMessage = await prisma.externalMessage.create({
        data: {
          tenantId,
          connectionId: tenantId,
          type: MarketplaceType.AMAZON,
          externalId: payload.messageId,
          buyerEmail: payload.from,
          receivedAt: new Date(payload.receivedAt),
          raw: {
            from: payload.from,
            to: payload.to,
            subject: payload.subject || "",
            body: cleanBody,  // Store clean body, not raw MIME
            messageId: payload.messageId,
            attachmentCount: parsedEmail.attachments.length,
          },
        },
      });

      console.log("[Webhook] ExternalMessage created:", externalMessage.id);

      // Update InboundAddress lastInboundAt
      await prisma.inboundAddress.updateMany({
        where: {
          tenantId,
          marketplace: MarketplaceType.AMAZON,
          country,
        },
        data: {
          lastInboundAt: new Date(),
          lastInboundMessageId: payload.messageId,
        },
      });

      // PH15: Create Inbox conversation + message (product DB) - with clean body
      let conversationResult = null;
      let storedAttachments: any[] = [];
      
      try {
        conversationResult = await createInboxConversation({
          tenantId,
          marketplace: 'amazon',
          from: payload.from,
          subject: payload.subject || 'Message Amazon',
          body: cleanBody,  // Use clean body without base64
          messageId: payload.messageId,
          receivedAt: new Date(payload.receivedAt),
        });
        console.log("[Webhook] Inbox conversation created:", conversationResult);

        // ===== PH-MVP-ATTACHMENTS-RENDER-01: Store attachments linked to message =====
        if (parsedEmail.attachments.length > 0 && conversationResult.messageId) {
          try {
            storedAttachments = await storeAttachments({
              tenantId,
              messageId: conversationResult.messageId,
              attachments: parsedEmail.attachments,
            });
            console.log(`[Webhook] Stored ${storedAttachments.length} attachments for message ${conversationResult.messageId}`);
          } catch (attError) {
            console.error("[Webhook] Failed to store attachments:", attError);
            // Don't fail the request, continue without attachments
          }
        }
      } catch (convError) {
        console.error("[Webhook] Failed to create Inbox conversation:", convError);
      }

      return reply.send({
        success: true,
        messageId: externalMessage.id,
        externalId: payload.messageId,
        amazonForward: amazonUpdated,
        conversation: conversationResult,
        attachments: storedAttachments.map(a => ({
          id: a.id,
          filename: a.filename,
          mimeType: a.mimeType,
          size: a.size,
          downloadUrl: a.downloadUrl,
        })),
      });

    } catch (error) {
      console.error("[Webhook] Error processing inbound email:", error);
      return reply.code(500).send({ error: "Internal server error" });
    }
  });
}

// Export as regular function to be registered with prefix
export async function registerInboundEmailWebhookRoutes(server: FastifyInstance) {
  await server.register(inboundEmailWebhookPlugin, { prefix: '/api/v1/webhooks' });
}
