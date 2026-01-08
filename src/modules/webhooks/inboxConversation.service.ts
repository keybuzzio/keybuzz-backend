/**
 * PH15-INBOUND-TO-CONVERSATION-01 + PH15-INBOUND-MESSAGE-NORMALIZATION-01
 * Service to create Inbox conversations and messages from inbound emails
 * With message normalization for clean Inbox display
 */
import { productDb } from '../../lib/productDb';
import { randomBytes } from 'crypto';
import { normalizeInboundMessage } from './messageNormalizer.service';

// Generate cuid-like ID (compatible with existing data)
function createId(): string {
  const timestamp = Date.now().toString(36);
  const random = randomBytes(8).toString('hex');
  return `cm${timestamp}${random}`.substring(0, 25);
}

interface InboundEmailPayload {
  tenantId: string;
  marketplace: string;
  from: string;
  subject: string;
  body: string;
  messageId: string;
  receivedAt: Date;
  orderRef?: string;
}

interface ConversationResult {
  conversationId: string;
  messageId: string;
  isNew: boolean;
  normalized: {
    cleanBodyLength: number;
    extractionMethod: string;
  };
}

/**
 * Extract customer name from email "from" field
 */
function extractCustomerName(from: string): string {
  // Format: "Name email@domain.com" or "Name <email@domain.com>"
  const match = from.match(/^([^<@]+)/);
  if (match) {
    return match[1].trim().replace(/["']/g, '');
  }
  return from.split('@')[0];
}

/**
 * Create or find existing conversation, then add message
 * Idempotent based on messageId
 * Now with message normalization!
 */
export async function createInboxConversation(payload: InboundEmailPayload): Promise<ConversationResult> {
  const {
    tenantId,
    marketplace,
    from,
    subject,
    body,
    messageId,
    receivedAt,
  } = payload;

  // ===== PH15: NORMALIZE THE MESSAGE =====
  const normalized = normalizeInboundMessage({
    rawBody: body,
    rawSubject: subject,
    rawFrom: from,
    rawTo: '', // Not always available
    marketplace: marketplace,
  });
  
  const cleanBody = normalized.cleanBody;
  const preview = normalized.preview;
  const metadata = normalized.metadata;
  
  // Use orderRef from metadata if not in payload
  const orderRef = payload.orderRef || metadata.orderRef || null;
  // ========================================

  // Build deterministic external_id for idempotency
  const externalId = `${marketplace}:${messageId}`;
  
  // Check if message already exists
  const existingMsg = await productDb.query(
    `SELECT id, conversation_id FROM messages WHERE tenant_id = $1 AND id LIKE $2`,
    [tenantId, `%${messageId.substring(0, 20)}%`]
  );
  
  if (existingMsg.rows.length > 0) {
    console.log(`[InboxConversation] Message already exists: ${messageId}`);
    return {
      conversationId: existingMsg.rows[0].conversation_id,
      messageId: existingMsg.rows[0].id,
      isNew: false,
      normalized: {
        cleanBodyLength: cleanBody.length,
        extractionMethod: metadata.extractionMethod,
      },
    };
  }

  const customerName = extractCustomerName(from);
  const customerHandle = from;
  const now = receivedAt || new Date();

  // Calculate SLA (24h from now for Amazon)
  const slaDueAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);

  // Try to find existing open conversation for same customer + orderRef
  let conversationId: string | null = null;
  let isNewConversation = false;

  if (orderRef) {
    const existingConv = await productDb.query(
      `SELECT id FROM conversations 
       WHERE tenant_id = $1 AND channel = $2 AND order_ref = $3 AND status = 'open'
       ORDER BY created_at DESC LIMIT 1`,
      [tenantId, marketplace.toLowerCase(), orderRef]
    );
    if (existingConv.rows.length > 0) {
      conversationId = existingConv.rows[0].id;
    }
  }

  // Create new conversation if needed
  if (!conversationId) {
    conversationId = createId();
    isNewConversation = true;

    await productDb.query(
      `INSERT INTO conversations (
        id, tenant_id, subject, channel, status, priority,
        customer_name, customer_handle, order_ref,
        last_message_preview, last_inbound_at, last_activity_at,
        messages_24h, sla_due_at, sla_state, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
      [
        conversationId,
        tenantId,
        subject || 'Message Amazon',
        marketplace.toLowerCase(),
        'open',
        'normal',
        customerName,
        customerHandle,
        orderRef,
        preview,  // Use normalized preview
        now,
        now,
        1,
        slaDueAt,
        'ok',
        now,
        now,
      ]
    );

    console.log(`[InboxConversation] Created conversation: ${conversationId}`);
  }

  // Create message with clean body and metadata
  const msgId = createId();
  await productDb.query(
    `INSERT INTO messages (
      id, conversation_id, tenant_id, direction, author_name, body,
      created_at, visibility, message_source, metadata
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      msgId,
      conversationId,
      tenantId,
      'inbound',
      customerName,
      cleanBody,  // Use normalized clean body!
      now,
      'public',
      'HUMAN',
      JSON.stringify(metadata),  // Store metadata as JSON
    ]
  );

  console.log(`[InboxConversation] Created message: ${msgId}, cleanBodyLength=${cleanBody.length}`);

  // Update conversation stats with normalized preview
  await productDb.query(
    `UPDATE conversations SET
      last_message_preview = $1,
      last_inbound_at = $2,
      last_activity_at = $3,
      messages_24h = messages_24h + 1,
      updated_at = $4
     WHERE id = $5`,
    [preview, now, now, now, conversationId]
  );

  return {
    conversationId,
    messageId: msgId,
    isNew: isNewConversation,
    normalized: {
      cleanBodyLength: cleanBody.length,
      extractionMethod: metadata.extractionMethod,
    },
  };
}
