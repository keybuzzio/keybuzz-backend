/**
 * PH15-INBOUND-TO-CONVERSATION-01
 * Service to create Inbox conversations and messages from inbound emails
 */
import { productDb } from '../../lib/productDb';
import { randomBytes } from 'crypto';

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
}

/**
 * Extract order reference from email content
 */
function extractOrderRef(subject: string, body: string): string | null {
  // Amazon order formats: 123-1234567-1234567, ORDER-xxx
  const patterns = [
    /\b(\d{3}-\d{7}-\d{7})\b/,  // Amazon order ID
    /ORDER[:\s#-]*([A-Z0-9-]+)/i,
    /commande[:\s#-]*([A-Z0-9-]+)/i,
  ];
  
  const text = `${subject} ${body}`;
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1];
  }
  return null;
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
 * Truncate text for preview
 */
function truncateForPreview(text: string, maxLen = 150): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= maxLen) return cleaned;
  return cleaned.substring(0, maxLen - 3) + '...';
}

/**
 * Create or find existing conversation, then add message
 * Idempotent based on messageId
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
    };
  }

  const orderRef = extractOrderRef(subject, body) || payload.orderRef || null;
  const customerName = extractCustomerName(from);
  const customerHandle = from;
  const preview = truncateForPreview(body);
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
        preview,
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

  // Create message
  const msgId = createId();
  await productDb.query(
    `INSERT INTO messages (
      id, conversation_id, tenant_id, direction, author_name, body,
      created_at, visibility, message_source
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      msgId,
      conversationId,
      tenantId,
      'inbound',
      customerName,
      body,
      now,
      'public',
      'HUMAN',
    ]
  );

  console.log(`[InboxConversation] Created message: ${msgId}`);

  // Update conversation stats
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
  };
}
