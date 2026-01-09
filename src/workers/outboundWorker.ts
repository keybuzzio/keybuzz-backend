/**
 * Outbound Worker - PH15-OUTBOUND-WORKER-REFORM-01
 * Refactored with atomic claim + autocommit pattern
 * NO explicit transactions, NO double release
 * v4.0.1 - Fixed HTML formatting for proper paragraph rendering
 */

import { Pool, PoolClient } from 'pg';
import { sendEmail, getEmailServiceStatus } from '../services/emailService';
import { sendSpapiMessage } from '../services/spapiMessaging';

// Configuration
const POLL_INTERVAL_MS = parseInt(process.env.OUTBOUND_POLL_INTERVAL_MS || '2000', 10);
const MAX_ATTEMPTS = 5;
const BASE_RETRY_DELAY_MS = 60000; // 1 minute

const PG_CONFIG = {
    host: process.env.PGHOST || 'localhost',
    port: parseInt(process.env.PGPORT || '5432', 10),
    database: process.env.PGDATABASE || 'keybuzz',
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
};

let pool: Pool | null = null;

function getPool(): Pool {
    if (!pool) {
        pool = new Pool(PG_CONFIG);
        pool.on('error', (err) => {
            console.error('[Worker] Pool error:', err.message);
        });
    }
    return pool;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// Add jitter to prevent thundering herd
function jitter(baseMs: number): number {
    return baseMs + Math.floor(Math.random() * 1000);
}

// Calculate exponential backoff for retries
function calculateNextAttempt(attemptCount: number): Date {
    const delayMs = BASE_RETRY_DELAY_MS * Math.pow(2, attemptCount - 1);
    const maxDelay = 3600000; // 1 hour max
    return new Date(Date.now() + Math.min(delayMs, maxDelay));
}

// ============================================================
// TEXT TO HTML CONVERSION - Proper paragraph formatting
// ============================================================
function textToHtml(text: string): string {
    if (!text) return '<p></p>';
    
    // Escape HTML special chars
    const escaped = text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    
    // Split into paragraphs (double line breaks or more)
    const paragraphs = escaped.split(/\n\s*\n/).filter(p => p.trim());
    
    if (paragraphs.length === 0) {
        // No double line breaks, treat as single paragraph with line breaks
        return `<p>${escaped.replace(/\n/g, '<br>')}</p>`;
    }
    
    // Each paragraph: replace single \n with <br>, wrap in <p>
    return paragraphs
        .map(p => `<p>${p.trim().replace(/\n/g, '<br>')}</p>`)
        .join('\n');
}

// ============================================================
// ATOMIC CLAIM - Single autocommit query with FOR UPDATE SKIP LOCKED
// ============================================================
async function claimNextDelivery(client: PoolClient): Promise<any | null> {
    const result = await client.query(`
    WITH next AS (
      SELECT id
      FROM outbound_deliveries
      WHERE status = 'queued'
        AND (next_retry_at IS NULL OR next_retry_at <= now())
      ORDER BY created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    UPDATE outbound_deliveries d
    SET status = 'sending',
        updated_at = now(),
        attempt_count = COALESCE(attempt_count, 0) + 1
    FROM next
    WHERE d.id = next.id
    RETURNING d.*
  `);
    return result.rows.length > 0 ? result.rows[0] : null;
}

// ============================================================
// STATUS UPDATE FUNCTIONS (autocommit)
// ============================================================
async function markDelivered(client: PoolClient, deliveryId: string, provider: string, trace: any): Promise<void> {
    await client.query(`
    UPDATE outbound_deliveries
    SET status = 'delivered',
        provider = $2,
        delivery_trace = $3::jsonb,
        delivered_at = now(),
        updated_at = now(),
        last_error = NULL
    WHERE id = $1
  `, [deliveryId, provider, JSON.stringify(trace)]);
}

async function markFailed(client: PoolClient, deliveryId: string, error: string, attemptCount: number, trace: any): Promise<void> {
    const isFinal = attemptCount >= MAX_ATTEMPTS;
    const nextRetryAt = isFinal ? null : calculateNextAttempt(attemptCount);
    
    await client.query(`
    UPDATE outbound_deliveries
    SET status = $2,
        last_error = $3,
        delivery_trace = $4::jsonb,
        next_retry_at = $5,
        updated_at = now()
    WHERE id = $1
  `, [
        deliveryId,
        isFinal ? 'failed' : 'queued',
        error.substring(0, 500),
        JSON.stringify(trace),
        nextRetryAt
    ]);
}

// ============================================================
// HELPER FUNCTIONS
// ============================================================
interface ConversationDetails {
    orderId: string | null;
    threadKey: string | null;
    customerHandle: string | null;
    subject: string;
    amazonIds: any | null;
}

async function getConversationDetails(client: PoolClient, conversationId: string): Promise<ConversationDetails> {
    const result = await client.query(
        `SELECT order_ref, thread_key, customer_handle, subject FROM conversations WHERE id = $1`,
        [conversationId]
    );
    
    if (result.rows.length === 0) {
        return { orderId: null, threadKey: null, customerHandle: null, subject: 'Message', amazonIds: null };
    }
    
    const { order_ref, thread_key, customer_handle, subject } = result.rows[0];
    let amazonIds: any = null;
    
    if (thread_key && thread_key.startsWith('sc:')) {
        amazonIds = { threadId: thread_key.replace('sc:', '') };
    }
    
    // Get Amazon IDs from inbound message metadata
    const msgResult = await client.query(
        `SELECT metadata FROM messages 
         WHERE conversation_id = $1 AND direction = 'inbound' 
         ORDER BY created_at DESC LIMIT 1`,
        [conversationId]
    );
    
    if (msgResult.rows.length > 0 && msgResult.rows[0].metadata) {
        try {
            const meta = typeof msgResult.rows[0].metadata === 'string'
                ? JSON.parse(msgResult.rows[0].metadata)
                : msgResult.rows[0].metadata;
            if (meta.amazonIds) {
                amazonIds = { ...amazonIds, ...meta.amazonIds };
            }
        } catch {}
    }
    
    return {
        orderId: order_ref,
        threadKey: thread_key,
        customerHandle: customer_handle,
        subject: subject || 'Message',
        amazonIds,
    };
}

async function getMessageBody(client: PoolClient, messageId: string): Promise<string> {
    const result = await client.query(`SELECT body FROM messages WHERE id = $1`, [messageId]);
    return result.rows[0]?.body || '';
}

async function getLastInboundMessageId(client: PoolClient, conversationId: string): Promise<string | null> {
    try {
        const result = await client.query(
            `SELECT id, metadata FROM messages 
             WHERE conversation_id = $1 AND direction = 'inbound'
             ORDER BY created_at DESC LIMIT 1`,
            [conversationId]
        );
        
        if (result.rows.length > 0) {
            const row = result.rows[0];
            if (row.metadata) {
                const meta = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata;
                if (meta.messageId || meta.externalId) {
                    return meta.messageId || meta.externalId;
                }
            }
            return row.id;
        }
    } catch (err) {
        // Ignore errors, return null
    }
    return null;
}

// ============================================================
// PROCESS DELIVERY (NO TRANSACTION - just business logic)
// ============================================================
async function processDelivery(client: PoolClient, delivery: any): Promise<void> {
    console.log(`[Worker] Processing ${delivery.id} (provider: ${delivery.provider}, attempt: ${delivery.attempt_count})`);
    
    const trace: any = {
        processedAt: new Date().toISOString(),
        provider: delivery.provider,
        workerVersion: '4.0.1-html-fix',
        attemptCount: delivery.attempt_count,
    };
    
    try {
        let actualProvider = delivery.provider;
        
        // ---- MOCK PROVIDER ----
        if (delivery.provider === 'mock') {
            trace.note = 'Simulated delivery (mock provider)';
            trace.mockResult = 'success';
            await markDelivered(client, delivery.id, 'mock', trace);
            console.log(`[Worker] ${delivery.id} delivered (mock)`);
            return;
        }
        
        // ---- SPAPI / AMAZON PROVIDER ----
        if (delivery.provider === 'spapi') {
            const convDetails = await getConversationDetails(client, delivery.conversation_id);
            const messageBody = await getMessageBody(client, delivery.message_id);
            
            if (!messageBody) {
                throw new Error('No message body found');
            }
            
            const { orderId, threadKey, customerHandle, subject, amazonIds } = convDetails;
            
            if (orderId) {
                // Case A: Order-based -> SP-API
                console.log(`[Worker] Using SP-API for order ${orderId}`);
                const result = await sendSpapiMessage({
                    tenantId: delivery.tenant_id,
                    orderId,
                    message: messageBody,
                });
                
                if (result.success) {
                    trace.amazonMessageId = result.messageId;
                    trace.orderId = orderId;
                    actualProvider = 'SPAPI_ORDER';
                } else {
                    throw new Error(`SP-API failed: ${result.error}`);
                }
            } else if (customerHandle && customerHandle.includes('@marketplace.amazon')) {
                // Case B: Non-order -> Enhanced SMTP
                console.log(`[Worker] Using enhanced SMTP for Amazon non-order`);
                const lastMessageId = await getLastInboundMessageId(client, delivery.conversation_id);
                const emailSubject = subject.startsWith('Re:') ? subject : `Re: ${subject}`;
                
                // Use proper HTML formatting with paragraphs
                const emailResult = await sendEmail({
                    to: customerHandle,
                    subject: emailSubject,
                    html: textToHtml(messageBody),
                    text: messageBody,
                    replyTo: delivery.reply_to,
                    inReplyTo: lastMessageId ? `<${lastMessageId}>` : undefined,
                    references: lastMessageId ? `<${lastMessageId}>` : undefined,
                });
                
                if (emailResult.success) {
                    trace.emailMessageId = emailResult.messageId;
                    trace.targetAddress = customerHandle;
                    trace.amazonThreadKey = threadKey;
                    trace.amazonIds = amazonIds;
                    actualProvider = 'SMTP_AMAZON_NONORDER';
                } else {
                    throw new Error(`SMTP failed: ${emailResult.error}`);
                }
            } else if (delivery.target_address && delivery.target_address.includes('@')) {
                // Case C: Fallback SMTP
                console.log(`[Worker] Using fallback SMTP`);
                const emailSubject = subject.startsWith('Re:') ? subject : `Re: ${subject}`;
                
                // Use proper HTML formatting with paragraphs
                const emailResult = await sendEmail({
                    to: delivery.target_address,
                    subject: emailSubject,
                    html: textToHtml(messageBody),
                    text: messageBody,
                });
                
                if (emailResult.success) {
                    trace.emailMessageId = emailResult.messageId;
                    actualProvider = 'SMTP_FALLBACK';
                } else {
                    throw new Error(`SMTP failed: ${emailResult.error}`);
                }
            } else {
                throw new Error('No order ID and no valid email address');
            }
            
            await markDelivered(client, delivery.id, actualProvider, trace);
            console.log(`[Worker] ${delivery.id} delivered via ${actualProvider}`);
            return;
        }
        
        // ---- EMAIL/SMTP PROVIDER ----
        if (delivery.provider === 'email_forward' || delivery.provider === 'smtp') {
            const convDetails = await getConversationDetails(client, delivery.conversation_id);
            const emailResult = await sendEmail({
                to: delivery.target_address,
                subject: delivery.subject || `Re: ${convDetails.subject}`,
                html: delivery.body_html || textToHtml(delivery.body) || '<p>No content</p>',
                text: delivery.body_text || delivery.body,
                replyTo: delivery.reply_to,
            });
            
            if (emailResult.success) {
                trace.emailMessageId = emailResult.messageId;
                actualProvider = emailResult.provider || 'smtp';
                await markDelivered(client, delivery.id, actualProvider, trace);
                console.log(`[Worker] ${delivery.id} delivered via ${actualProvider}`);
                return;
            } else {
                throw new Error(emailResult.error || 'Email send failed');
            }
        }
        
        // Unknown provider
        throw new Error(`Unknown provider: ${delivery.provider}`);
    } catch (err: any) {
        trace.error = err.message;
        trace.failedAt = new Date().toISOString();
        console.error(`[Worker] ${delivery.id} failed:`, err.message);
        await markFailed(client, delivery.id, err.message, delivery.attempt_count, trace);
    }
}

// ============================================================
// MAIN WORKER LOOP
// ============================================================
async function workerLoop(): Promise<void> {
    console.log('[Worker] Starting outbound worker v4.0.1-html-fix...');
    console.log(`[Worker] Poll interval: ${POLL_INTERVAL_MS}ms`);
    console.log(`[Worker] Max attempts: ${MAX_ATTEMPTS}`);
    
    const emailStatus = getEmailServiceStatus();
    console.log(`[Worker] Email: SMTP ${emailStatus.smtp.configured ? 'OK' : 'N/A'}, SES ${emailStatus.ses.configured ? 'OK' : 'N/A'}`);
    
    while (true) {
        let client: PoolClient | null = null;
        try {
            client = await getPool().connect();
            
            // Atomic claim - single autocommit query
            const delivery = await claimNextDelivery(client);
            
            if (delivery) {
                await processDelivery(client, delivery);
            } else {
                await sleep(jitter(POLL_INTERVAL_MS));
            }
        } catch (err: any) {
            console.error('[Worker] Loop error:', err.message);
            await sleep(jitter(POLL_INTERVAL_MS * 2));
        } finally {
            if (client) {
                client.release();
            }
        }
    }
}

// ============================================================
// STARTUP
// ============================================================
workerLoop().catch((error) => {
    console.error('[Worker] Fatal error:', error);
    process.exit(1);
});

process.on('SIGTERM', async () => {
    console.log('[Worker] Received SIGTERM, shutting down...');
    if (pool) await pool.end();
    process.exit(0);
});

process.on('SIGINT', async () => {
    console.log('[Worker] Received SIGINT, shutting down...');
    if (pool) await pool.end();
    process.exit(0);
});
