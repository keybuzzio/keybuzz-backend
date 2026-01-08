/**
 * PH15-INBOUND-TO-CONVERSATION-01 + PH15-AMAZON-THREADING-ENCODING-01
 * Service to create Inbox conversations and messages from inbound emails
 * With message normalization and Amazon thread grouping
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
  headers?: Record<string, string>;
}

interface ConversationResult {
  conversationId: string;
  messageId: string;
  isNew: boolean;
  isThreaded: boolean;  // PH15: Message was added to existing thread
  normalized: {
    cleanBodyLength: number;
    extractionMethod: string;
    threadKey: string | null;
    encodingFixed: boolean;
  };
}

/**
 * Extract customer name from email "from" field
 */
function extractCustomerName(from: string): string {
  const match = from.match(/^([^<@]+)/);
  if (match) {
    return match[1].trim().replace(/["']/g, '');
  }
  return from.split('@')[0];
}

/**
 * Create or find existing conversation, then add message
 * Now with Amazon thread grouping!
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
    headers = {},
  } = payload;

  // ===== NORMALIZE THE MESSAGE =====
  const normalized = normalizeInboundMessage({
    rawBody: body,
    rawSubject: subject,
    rawFrom: from,
    rawTo: '',
    marketplace: marketplace,
    headers: headers,
  });
  
  const cleanBody = normalized.cleanBody;
  const preview = normalized.preview;
  const metadata = normalized.metadata;
  
  const orderRef = payload.orderRef || metadata.orderRef || null;
  const threadKey = metadata.threadKey || null;
  
  // ===== MESSAGE IDEMPOTENCY (based on messageId) =====
  // Check if this specific message already exists
  const existingMsg = await productDb.query(
    `SELECT id, conversation_id FROM messages 
     WHERE tenant_id = $1 AND metadata->>'rawPreview' LIKE $2
     LIMIT 1`,
    [tenantId, `%${messageId.substring(0, 30)}%`]
  );
  
  if (existingMsg.rows.length > 0) {
    console.log(`[InboxConversation] Message already exists: ${messageId}`);
    return {
      conversationId: existingMsg.rows[0].conversation_id,
      messageId: existingMsg.rows[0].id,
      isNew: false,
      isThreaded: false,
      normalized: {
        cleanBodyLength: cleanBody.length,
        extractionMethod: metadata.extractionMethod,
        threadKey,
        encodingFixed: metadata.encodingFixed || false,
      },
    };
  }

  const customerName = extractCustomerName(from);
  const customerHandle = from;
  const now = receivedAt || new Date();
  const slaDueAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);

  // ===== CONVERSATION GROUPING (PH15) =====
  // Priority: threadKey > orderRef > new conversation
  let conversationId: string | null = null;
  let isNewConversation = false;
  let isThreaded = false;

  // 1) Try to find by threadKey
  if (threadKey) {
    const existingByThread = await productDb.query(
      `SELECT id FROM conversations 
       WHERE tenant_id = $1 AND channel = $2 AND thread_key = $3 AND status = 'open'
       ORDER BY created_at DESC LIMIT 1`,
      [tenantId, marketplace.toLowerCase(), threadKey]
    );
    if (existingByThread.rows.length > 0) {
      conversationId = existingByThread.rows[0].id;
      isThreaded = true;
      console.log(`[InboxConversation] Found existing conversation by threadKey: ${threadKey}`);
    }
  }

  // 2) Fallback: try by orderRef (if no threadKey match)
  if (!conversationId && orderRef) {
    const existingByOrder = await productDb.query(
      `SELECT id FROM conversations 
       WHERE tenant_id = $1 AND channel = $2 AND order_ref = $3 AND status = 'open'
       ORDER BY created_at DESC LIMIT 1`,
      [tenantId, marketplace.toLowerCase(), orderRef]
    );
    if (existingByOrder.rows.length > 0) {
      conversationId = existingByOrder.rows[0].id;
      isThreaded = true;
      console.log(`[InboxConversation] Found existing conversation by orderRef: ${orderRef}`);
      
      // Update thread_key if not set
      if (threadKey) {
        await productDb.query(
          `UPDATE conversations SET thread_key = $1 WHERE id = $2 AND thread_key IS NULL`,
          [threadKey, conversationId]
        );
      }
    }
  }

  // 3) Create new conversation if no match
  if (!conversationId) {
    conversationId = createId();
    isNewConversation = true;

    await productDb.query(
      `INSERT INTO conversations (
        id, tenant_id, subject, channel, status, priority,
        customer_name, customer_handle, order_ref, thread_key,
        last_message_preview, last_inbound_at, last_activity_at,
        messages_24h, sla_due_at, sla_state, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
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
        threadKey,  // PH15: Store thread key
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

    console.log(`[InboxConversation] Created new conversation: ${conversationId}, threadKey: ${threadKey}`);
  }

  // ===== CREATE MESSAGE =====
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
      cleanBody,
      now,
      'public',
      'HUMAN',
      JSON.stringify(metadata),
    ]
  );

  console.log(`[InboxConversation] Created message: ${msgId}, threaded=${isThreaded}`);

  // ===== UPDATE CONVERSATION STATS =====
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
    isThreaded,
    normalized: {
      cleanBodyLength: cleanBody.length,
      extractionMethod: metadata.extractionMethod,
      threadKey,
      encodingFixed: metadata.encodingFixed || false,
    },
  };
}
