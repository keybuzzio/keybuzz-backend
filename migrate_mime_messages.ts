/**
 * PH-ATTACHMENTS-DOWNLOAD-TRUTH-01: Migrate existing MIME messages
 * Re-parse messages with MIME content and create attachments
 */
import { productDb } from './src/lib/productDb';
import { parseMimeEmail, storeAttachments } from './src/modules/webhooks/attachmentParser.service';

async function migrateMessages() {
  console.log('[Migration] Starting MIME message migration...');
  
  // Find messages with MIME content but no attachments
  const result = await productDb.query(`
    SELECT m.id, m.body, m.tenant_id, m.conversation_id
    FROM messages m
    WHERE (m.body LIKE '%Content-Disposition:%' OR m.body LIKE '%JVBERi0%')
      AND NOT EXISTS (
        SELECT 1 FROM message_attachments ma 
        WHERE ma.message_id = m.id AND ma.storage_key IS NOT NULL
      )
    ORDER BY m.created_at DESC
  `);
  
  console.log(`[Migration] Found ${result.rows.length} messages to migrate`);
  
  let successCount = 0;
  let errorCount = 0;
  
  for (const row of result.rows) {
    try {
      console.log(`\n[Migration] Processing message: ${row.id}`);
      
      // Parse MIME content
      const parsed = parseMimeEmail(row.body);
      
      if (parsed.attachments.length === 0) {
        console.log(`[Migration] No attachments found in message ${row.id}`);
        
        // Still update body if we got cleaner text
        if (parsed.textBody && parsed.textBody.length > 0 && parsed.textBody.length < row.body.length / 2) {
          const newBody = parsed.textBody || '[Pièce jointe reçue]';
          await productDb.query(
            'UPDATE messages SET body = $1 WHERE id = $2',
            [newBody, row.id]
          );
          console.log(`[Migration] Updated body for ${row.id}`);
        }
        continue;
      }
      
      console.log(`[Migration] Found ${parsed.attachments.length} attachment(s)`);
      
      // Store attachments
      const stored = await storeAttachments({
        tenantId: row.tenant_id,
        messageId: row.id,
        attachments: parsed.attachments,
      });
      
      console.log(`[Migration] Stored ${stored.length} attachment(s) for message ${row.id}`);
      
      // Update message body
      const newBody = parsed.textBody && parsed.textBody.length > 5 
        ? parsed.textBody 
        : '[Pièce jointe reçue]';
      
      await productDb.query(
        'UPDATE messages SET body = $1 WHERE id = $2',
        [newBody, row.id]
      );
      
      console.log(`[Migration] Updated message body to: "${newBody.substring(0, 50)}..."`);
      successCount++;
      
    } catch (error) {
      console.error(`[Migration] Error processing message ${row.id}:`, error);
      errorCount++;
    }
  }
  
  console.log(`\n[Migration] Complete!`);
  console.log(`[Migration] Success: ${successCount}, Errors: ${errorCount}`);
}

// Run migration
migrateMessages()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[Migration] Fatal error:', err);
    process.exit(1);
  });
