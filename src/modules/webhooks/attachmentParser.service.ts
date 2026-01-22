/**
 * PH-MVP-ATTACHMENTS-RENDER-01: MIME Attachment Parser
 * Extracts attachments from multipart emails and stores them in MinIO
 * Updated to use mailparser for robust MIME handling
 */

import { Client as MinioClient } from 'minio';
import { simpleParser, ParsedMail } from 'mailparser';
import { productDb } from '../../lib/productDb';
import { randomBytes } from 'crypto';

// MinIO client (internal only - via HAProxy)
const minioEndpoint = process.env.MINIO_ENDPOINT?.replace('http://', '').split(':')[0] || '10.0.0.11';
const minioPort = parseInt(process.env.MINIO_PORT || '9000');
const BUCKET = process.env.MINIO_BUCKET_ATTACHMENTS || 'keybuzz-attachments';

const minioClient = new MinioClient({
  endPoint: minioEndpoint,
  port: minioPort,
  useSSL: false,
  accessKey: process.env.MINIO_ACCESS_KEY || 'keybuzz-admin',
  secretKey: process.env.MINIO_SECRET_KEY || '',
});

export interface ParsedAttachment {
  filename: string;
  mimeType: string;
  content: Buffer;
  contentId?: string;
  isInline: boolean;
}

export interface ParsedEmail {
  textBody: string;
  htmlBody: string;
  attachments: ParsedAttachment[];
}

export interface StoredAttachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  storageKey: string;
  isInline: boolean;
  downloadUrl: string;
}

/**
 * Parse a raw MIME email using mailparser for robust handling
 */
export async function parseMimeEmailAsync(rawEmail: string): Promise<ParsedEmail> {
  const result: ParsedEmail = {
    textBody: '',
    htmlBody: '',
    attachments: [],
  };

  try {
    // Add MIME headers if missing (common for Amazon forwarded emails)
    let emailContent = rawEmail;
    if (!emailContent.includes('MIME-Version:') && !emailContent.includes('Content-Type:')) {
      // Check for boundary pattern in body
      const boundaryMatch = emailContent.match(/(------=_Part_\d+)/);
      if (boundaryMatch) {
        emailContent = `MIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="${boundaryMatch[1]}"\r\n\r\n${emailContent}`;
      }
    }

    const parsed: ParsedMail = await simpleParser(emailContent);

    // Extract text body
    if (parsed.text) {
      result.textBody = parsed.text.trim();
    } else if (parsed.html) {
      result.textBody = htmlToText(parsed.html);
    }

    // Extract attachments
    if (parsed.attachments && parsed.attachments.length > 0) {
      for (const att of parsed.attachments) {
        if (att.content && att.content.length > 0) {
          result.attachments.push({
            filename: att.filename || `attachment_${Date.now()}`,
            mimeType: att.contentType || 'application/octet-stream',
            content: att.content,
            contentId: att.contentId?.replace(/[<>]/g, ''),
            isInline: att.contentDisposition === 'inline',
          });
          console.log(`[MimeParser] mailparser extracted: ${att.filename} (${att.content.length} bytes)`);
        }
      }
    }

    console.log(`[MimeParser] mailparser result: text=${result.textBody.length} chars, attachments=${result.attachments.length}`);

  } catch (error) {
    console.warn('[MimeParser] mailparser failed, falling back to manual:', error);
    // Fallback to manual parsing
    return parseMimeEmailManual(rawEmail);
  }

  // If mailparser found nothing, try manual
  if (result.textBody.length === 0 && result.attachments.length === 0) {
    console.log('[MimeParser] mailparser found nothing, trying manual');
    return parseMimeEmailManual(rawEmail);
  }

  return result;
}

/**
 * Synchronous wrapper for compatibility
 */
export function parseMimeEmail(rawEmail: string): ParsedEmail {
  // For sync context, use manual parser
  // Async version should be used when possible
  return parseMimeEmailManual(rawEmail);
}

/**
 * Manual MIME parser as fallback
 */
function parseMimeEmailManual(rawEmail: string): ParsedEmail {
  const result: ParsedEmail = {
    textBody: '',
    htmlBody: '',
    attachments: [],
  };

  // Check for Amazon simple format (Content-Disposition without proper MIME)
  if (rawEmail.includes('Content-Disposition: attachment;') && rawEmail.includes('filename=')) {
    console.log('[MimeParser] Detected Amazon simple format');
    
    // Split by boundary to get each part
    const boundaryMatch = rawEmail.match(/------=_Part_[^\r\n]+/);
    if (boundaryMatch) {
      const boundary = boundaryMatch[0];
      const parts = rawEmail.split(boundary);
      console.log(`[MimeParser] Found ${parts.length} MIME parts`);
      
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        
        // Skip parts without attachment disposition
        if (!part.includes('Content-Disposition: attachment;') && !part.includes('Content-Disposition:attachment;')) {
          continue;
        }
        
        // Extract filename from this part
        const fnMatch = part.match(/filename[*]?=['"]?([^'"\n;]+)/i);
        if (!fnMatch) continue;
        
        let filename = fnMatch[1].trim();
        if (filename.includes("''")) {
          try { filename = decodeURIComponent(filename.split("''")[1] || filename); } catch {}
        }
        
        // Determine mime type
        let mimeType = 'application/octet-stream';
        const ext = filename.toLowerCase().split('.').pop();
        if (ext === 'pdf') mimeType = 'application/pdf';
        else if (ext === 'jpg' || ext === 'jpeg') mimeType = 'image/jpeg';
        else if (ext === 'png') mimeType = 'image/png';
        
        // Find base64 content in this part (after double newline)
        const base64Match = part.match(/Content-Transfer-Encoding:\s*base64[\s\S]*?\n\n([A-Za-z0-9+/=\s]+)/i);
        if (base64Match && base64Match[1]) {
          const base64Content = base64Match[1].replace(/[\s\r\n]/g, '');
          
          if (base64Content.length > 100) {
            try {
              const buffer = Buffer.from(base64Content, 'base64');
              console.log(`[MimeParser] Extracted attachment ${i}: ${filename} (${buffer.length} bytes)`);
              result.attachments.push({
                filename,
                mimeType,
                content: buffer,
                isInline: false,
              });
            } catch (err) {
              console.warn(`[MimeParser] Base64 decode failed for ${filename}:`, err);
            }
          }
        }
      }
    }
    
    // Extract text from text/plain part (anywhere in the MIME structure)
    // Amazon format: attachment first, then multipart/alternative with text
    const textPlainMatch = rawEmail.match(/Content-Type:\s*text\/plain[^]*?\n\n([\s\S]*?)(?=------=_Part|$)/i);
    if (textPlainMatch && textPlainMatch[1]) {
      let extractedText = textPlainMatch[1].trim();
      // Decode quoted-printable
      extractedText = extractedText.replace(/=\r?\n/g, '');
      extractedText = extractedText.replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
      
      // Extract actual message after "Message:" header if present
      const msgMatch = extractedText.match(/Message:[\s-]*\n\n([\s\S]*)/i);
      if (msgMatch && msgMatch[1]) {
        extractedText = msgMatch[1].trim();
      }
      
      // Remove Amazon wrapper text
      extractedText = extractedText.replace(/^Vous avez recu un message\.\s*/i, '');
      extractedText = extractedText.trim();
      
      if (extractedText.length > 0) {
        console.log('[MimeParser] Extracted text from text/plain part:', extractedText.substring(0, 100));
        result.textBody = extractedText;
      }
    }
    
    // Fallback: try to get text before Content-Disposition
    if (!result.textBody) {
      const dispIdx = rawEmail.indexOf('Content-Disposition:');
      if (dispIdx > 0) {
        const textBefore = rawEmail.substring(0, dispIdx)
          .replace(/------=_Part_\d+/g, '')
          .replace(/Content-[^:]+:[^\n]+\n/gi, '')
          .replace(/_\d+\.\d+/g, '')
          .trim();
        
        if (textBefore.length > 3) {
          result.textBody = textBefore;
        }
      }
    }
    
    if (!result.textBody && result.attachments.length > 0) {
      result.textBody = '[Pièce jointe reçue]';
    }
    
    return result;
  }

  // Standard cleanup for non-MIME content
  result.textBody = cleanBodyText(rawEmail);
  return result;
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .trim();
}

function cleanBodyText(text: string): string {
  return text
    .replace(/[A-Za-z0-9+/=]{100,}/g, '') // Remove base64 blocks
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Store attachments in MinIO and create DB records
 */
export async function storeAttachments(params: {
  tenantId: string;
  messageId: string;
  attachments: ParsedAttachment[];
}): Promise<StoredAttachment[]> {
  const { tenantId, messageId, attachments } = params;
  const stored: StoredAttachment[] = [];

  for (const attachment of attachments) {
    try {
      const id = generateId();
      const timestamp = Date.now();
      const safeFilename = sanitizeFilename(attachment.filename);
      const storageKey = `${tenantId}/${timestamp}-${id}-${safeFilename}`;

      await minioClient.putObject(
        BUCKET,
        storageKey,
        attachment.content,
        attachment.content.length,
        { 'Content-Type': attachment.mimeType }
      );

      await productDb.query(
        `INSERT INTO message_attachments (
          id, message_id, tenant_id, filename, mime_type, size_bytes, 
          storage_key, status, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
        [
          id,
          messageId,
          tenantId,
          attachment.filename,
          attachment.mimeType,
          attachment.content.length,
          storageKey,
          'uploaded',
        ]
      );

      stored.push({
        id,
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        size: attachment.content.length,
        storageKey,
        isInline: attachment.isInline,
        downloadUrl: `/api/v1/attachments/${id}`,
      });

      console.log(`[AttachmentParser] Stored: ${attachment.filename} (${attachment.mimeType}, ${attachment.content.length} bytes)`);
    } catch (error) {
      console.error(`[AttachmentParser] Failed to store ${attachment.filename}:`, error);
    }
  }

  return stored;
}

function sanitizeFilename(filename: string): string {
  return filename.replace(/[^a-zA-Z0-9._-]/g, '_').substring(0, 100);
}

function generateId(): string {
  return 'att_' + randomBytes(12).toString('hex');
}

export default {
  parseMimeEmail,
  parseMimeEmailAsync,
  storeAttachments,
};
