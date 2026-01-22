/**
 * PH15-INBOUND-TO-CONVERSATION-01 + PH15-AMAZON-THREADING-ENCODING-01
 * Service to create Inbox conversations and messages from inbound emails
 * With message normalization and Amazon thread grouping
 */
import { productDb } from '../../lib/productDb';
import { randomBytes } from 'crypto';
import { normalizeInboundMessage } from './messageNormalizer.service';
import { parseMimeEmail, storeAttachments, ParsedAttachment } from './attachmentParser.service';

// Generate cuid-like ID (compatible with existing data)
function createId(): string {
  const timestamp = Date.now().toString(36);
  const random = randomBytes(8).toString('hex');
  return `cm${timestamp}${random}`.substring(0, 25);
}

// Simple MIME format parser for Amazon-style attachments (no boundary)
function parseSimpleMimeFormat(body: string): { textBody: string; attachments: ParsedAttachment[] } {
  const attachments: ParsedAttachment[] = [];
  let textBody = '';

  // Look for Content-Disposition: attachment pattern
  const attMatch = body.match(/Content-Disposition:\s*attachment;\s*filename[*]?=['"]?([^'"\n;]+)/i);
  
  if (attMatch) {
    let filename = attMatch[1].trim();
    
    // Decode RFC 2231 filename if needed
    if (filename.includes("''")) {
      const parts = filename.split("''");
      try {
        filename = decodeURIComponent(parts[1] || parts[0]);
      } catch { /* keep original */ }
    }
    
    console.log(`[SimpleParser] Found attachment: ${filename}`);
    
    // Determine mime type from filename
    let mimeType = 'application/octet-stream';
    if (filename.toLowerCase().endsWith('.pdf')) mimeType = 'application/pdf';
    else if (filename.toLowerCase().endsWith('.jpg') || filename.toLowerCase().endsWith('.jpeg')) mimeType = 'image/jpeg';
    else if (filename.toLowerCase().endsWith('.png')) mimeType = 'image/png';
    
    // Extract base64 content - look for PDF or image base64 patterns
    const base64Match = body.match(/(?:JVBERi0|iVBORw0|\/9j\/)[A-Za-z0-9+\/=\s\n]+/);
    
    if (base64Match) {
      const base64Content = base64Match[0].replace(/[\s\n]/g, '');
      try {
        const buffer = Buffer.from(base64Content, 'base64');
        
        if (buffer.length > 100) {
          console.log(`[SimpleParser] Decoded ${buffer.length} bytes`);
          attachments.push({
            filename,
            mimeType,
            content: buffer,
            isInline: false,
          });
        }
      } catch (err) {
        console.warn('[SimpleParser] Failed to decode base64:', err);
      }
    }
    
    // Extract any text before the attachment header
    const headerIndex = body.indexOf('Content-Disposition:');
    if (headerIndex > 0) {
      textBody = body.substring(0, headerIndex).trim()
        .replace(/Content-[^:]+:[^\n]+\n/gi, '')
        .replace(/_\d+\.\d+\s*/g, '')
        .trim();
    }
  }
  
  // If no text found and we have attachments, use placeholder
  if (!textBody && attachments.length > 0) {
    textBody = '[Pièce jointe reçue]';
  }
  
  return { textBody, attachments };
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

  // ===== PROCESS MIME ATTACHMENTS (PH-ATTACHMENTS-DOWNLOAD-TRUTH-01) =====
  try {
    // Check if body contains MIME content
    const rawBody = payload.body;
    if (rawBody && (rawBody.includes('Content-Disposition:') || rawBody.includes('Content-Type:') || /JVBERi0[A-Za-z0-9+\/=]{50,}/.test(rawBody))) {
      console.log('[InboxConversation] Detected MIME content, parsing for attachments...');
      
      let parsed = parseMimeEmail(rawBody);
      
      // FALLBACK: If standard parser found nothing, try simple format parser
      if (parsed.attachments.length === 0) {
        console.log('[InboxConversation] Standard parser found 0 attachments, trying simple format...');
        const simpleResult = parseSimpleMimeFormat(rawBody);
        if (simpleResult.attachments.length > 0) {
          parsed = { ...parsed, attachments: simpleResult.attachments, textBody: simpleResult.textBody || parsed.textBody };
          console.log(`[InboxConversation] Simple parser found ${simpleResult.attachments.length} attachment(s)`);
        }
      }
      
      if (parsed.attachments.length > 0) {
        console.log(`[InboxConversation] Found ${parsed.attachments.length} attachment(s), storing to MinIO...`);
        
        const stored = await storeAttachments({
          tenantId,
          messageId: msgId,
          attachments: parsed.attachments,
        });
        
        console.log(`[InboxConversation] Stored ${stored.length} attachment(s) successfully`);
        
        // Update message body if we extracted a cleaner text
        if (parsed.textBody && parsed.textBody.length > 0 && parsed.textBody !== cleanBody) {
          const newBody = parsed.textBody || '[Pièce jointe reçue]';
          await productDb.query(
            'UPDATE messages SET body = $1 WHERE id = $2',
            [newBody, msgId]
          );
          console.log('[InboxConversation] Updated message body with parsed content');
        } else if (parsed.attachments.length > 0 && (!parsed.textBody || parsed.textBody.length < 10)) {
          // If we have attachments but no meaningful text, set a placeholder
          await productDb.query(
            'UPDATE messages SET body = $1 WHERE id = $2',
            ['[Pièce jointe reçue]', msgId]
          );
          console.log('[InboxConversation] Set placeholder body for attachment-only message');
        }
      }
    }
  } catch (mimeError) {
    console.warn('[InboxConversation] MIME attachment processing failed:', mimeError);
  }

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
