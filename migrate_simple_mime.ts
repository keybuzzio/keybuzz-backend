/**
 * PH-ATTACHMENTS-DOWNLOAD-TRUTH-01: Migrate messages with simple MIME format
 * Format: Content-Disposition: attachment; filename=X\nBase64Content
 */
import { Client as MinioClient } from 'minio';
import { Pool } from 'pg';

const pool = new Pool({
  host: process.env.PGHOST || '10.0.0.10',
  port: parseInt(process.env.PGPORT || '5432'),
  user: process.env.PGUSER || 'keybuzz_api_dev',
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE || 'keybuzz',
});

const minioClient = new MinioClient({
  endPoint: process.env.MINIO_ENDPOINT || '10.0.0.11',
  port: parseInt(process.env.MINIO_PORT || '9000'),
  useSSL: false,
  accessKey: process.env.MINIO_ACCESS_KEY || 'keybuzz-admin',
  secretKey: process.env.MINIO_SECRET_KEY || '',
});

const BUCKET = 'keybuzz-attachments';

interface ExtractedAttachment {
  filename: string;
  mimeType: string;
  buffer: Buffer;
}

function parseSimpleMime(body: string): { text: string; attachments: ExtractedAttachment[] } {
  const attachments: ExtractedAttachment[] = [];
  let text = '';

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
    
    console.log(`[Parser] Found attachment: ${filename}`);
    
    // Determine mime type from filename
    let mimeType = 'application/octet-stream';
    if (filename.toLowerCase().endsWith('.pdf')) mimeType = 'application/pdf';
    else if (filename.toLowerCase().endsWith('.jpg') || filename.toLowerCase().endsWith('.jpeg')) mimeType = 'image/jpeg';
    else if (filename.toLowerCase().endsWith('.png')) mimeType = 'image/png';
    
    // Extract base64 content - it's the long string after the header
    // Look for JVBERi0 (PDF) or other base64 patterns
    const base64Match = body.match(/(?:JVBERi0|iVBORw0|\/9j\/)[A-Za-z0-9+\/=\s\n]+/);
    
    if (base64Match) {
      const base64Content = base64Match[0].replace(/[\s\n]/g, '');
      try {
        const buffer = Buffer.from(base64Content, 'base64');
        
        // Verify it's valid by checking PDF header
        if (buffer.length > 10) {
          console.log(`[Parser] Decoded ${buffer.length} bytes`);
          attachments.push({
            filename,
            mimeType,
            buffer,
          });
        }
      } catch (err) {
        console.warn('[Parser] Failed to decode base64:', err);
      }
    }
    
    // Extract any text before the attachment header
    const headerIndex = body.indexOf('Content-Disposition:');
    if (headerIndex > 0) {
      text = body.substring(0, headerIndex).trim();
      // Clean up any remaining headers
      text = text
        .replace(/Content-[^:]+:[^\n]+\n/gi, '')
        .replace(/_\d+\.\d+\s*/g, '') // Remove timestamp-like patterns
        .trim();
    }
  }
  
  // If no text found and we have attachments, use placeholder
  if (!text && attachments.length > 0) {
    text = '[Pièce jointe reçue]';
  }
  
  return { text, attachments };
}

async function migrateMessage(msgId: string): Promise<boolean> {
  console.log(`\n[Migration] Processing: ${msgId}`);
  
  const result = await pool.query(
    'SELECT id, body, tenant_id, conversation_id FROM messages WHERE id = $1',
    [msgId]
  );
  
  if (result.rows.length === 0) {
    console.log('[Migration] Message not found');
    return false;
  }
  
  const msg = result.rows[0];
  const parsed = parseSimpleMime(msg.body);
  
  if (parsed.attachments.length === 0) {
    console.log('[Migration] No attachments extracted');
    return false;
  }
  
  console.log(`[Migration] Found ${parsed.attachments.length} attachment(s)`);
  
  for (const att of parsed.attachments) {
    const attId = `att-${Date.now().toString(36)}${Math.random().toString(36).substring(2, 10)}`;
    const timestamp = Date.now();
    const safeFilename = att.filename.replace(/[^a-zA-Z0-9._-]/g, '_').substring(0, 100);
    const storageKey = `${msg.tenant_id}/${timestamp}-${attId}-${safeFilename}`;
    
    try {
      // Upload to MinIO
      await minioClient.putObject(
        BUCKET,
        storageKey,
        att.buffer,
        att.buffer.length,
        { 'Content-Type': att.mimeType }
      );
      console.log(`[Migration] Uploaded to MinIO: ${storageKey}`);
      
      // Create DB record
      await pool.query(
        `INSERT INTO message_attachments (
          id, message_id, tenant_id, filename, mime_type, size_bytes, 
          storage_key, status, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
        [
          attId,
          msgId,
          msg.tenant_id,
          att.filename,
          att.mimeType,
          att.buffer.length,
          storageKey,
          'uploaded',
        ]
      );
      console.log(`[Migration] Created attachment record: ${attId}`);
      
    } catch (err) {
      console.error('[Migration] Error storing attachment:', err);
      return false;
    }
  }
  
  // Update message body
  await pool.query(
    'UPDATE messages SET body = $1 WHERE id = $2',
    [parsed.text, msgId]
  );
  console.log(`[Migration] Updated message body to: "${parsed.text}"`);
  
  return true;
}

async function main() {
  console.log('[Migration] Starting simple MIME migration...');
  
  // Find messages with MIME content
  const result = await pool.query(`
    SELECT id FROM messages
    WHERE (body LIKE '%Content-Disposition:%' OR body LIKE '%JVBERi0%')
      AND NOT EXISTS (
        SELECT 1 FROM message_attachments ma 
        WHERE ma.message_id = messages.id AND ma.storage_key IS NOT NULL
      )
    ORDER BY created_at DESC
  `);
  
  console.log(`[Migration] Found ${result.rows.length} messages to migrate`);
  
  let success = 0;
  let failed = 0;
  
  for (const row of result.rows) {
    const ok = await migrateMessage(row.id);
    if (ok) success++;
    else failed++;
  }
  
  console.log(`\n[Migration] Complete! Success: ${success}, Failed: ${failed}`);
  
  await pool.end();
}

main().catch(console.error);
