/**
 * PH-MVP-ATTACHMENTS-RENDER-01: MIME Attachment Parser
 * Extracts attachments from multipart emails and stores them in MinIO
 */

import { Client as MinioClient } from 'minio';
import { prisma } from '../../lib/db';
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
 * Parse a raw MIME email to extract body and attachments
 */
export function parseMimeEmail(rawEmail: string): ParsedEmail {
  const result: ParsedEmail = {
    textBody: '',
    htmlBody: '',
    attachments: [],
  };

  // Check if it's a multipart email
  const boundaryMatch = rawEmail.match(/boundary="?([^"\s;]+)"?/i);
  
  if (!boundaryMatch) {
    // Not multipart - just return the body
    result.textBody = cleanBodyText(rawEmail);
    return result;
  }

  const boundary = boundaryMatch[1];
  const parts = rawEmail.split(new RegExp(`--${escapeRegex(boundary)}`));

  for (const part of parts) {
    if (part.trim() === '' || part.trim() === '--') continue;

    const headerEnd = part.indexOf('\r\n\r\n') !== -1 ? part.indexOf('\r\n\r\n') : part.indexOf('\n\n');
    if (headerEnd === -1) continue;

    const headers = part.substring(0, headerEnd);
    const body = part.substring(headerEnd + (part.includes('\r\n\r\n') ? 4 : 2));

    const contentType = extractHeader(headers, 'Content-Type') || 'text/plain';
    const contentDisposition = extractHeader(headers, 'Content-Disposition') || '';
    const contentTransferEncoding = extractHeader(headers, 'Content-Transfer-Encoding') || '';
    const contentId = extractHeader(headers, 'Content-ID')?.replace(/[<>]/g, '');

    // Check if it's an attachment
    const isAttachment = contentDisposition.toLowerCase().includes('attachment') ||
                         contentDisposition.toLowerCase().includes('inline') ||
                         isAttachmentType(contentType);

    if (isAttachment && !contentType.startsWith('text/plain') && !contentType.startsWith('text/html')) {
      // Extract attachment
      const filename = extractFilename(contentDisposition, contentType) || `attachment_${Date.now()}`;
      const mimeType = contentType.split(';')[0].trim();
      const isInline = contentDisposition.toLowerCase().includes('inline') || !!contentId;

      let content: Buffer;
      if (contentTransferEncoding.toLowerCase() === 'base64') {
        // Remove whitespace and decode base64
        const cleanBase64 = body.replace(/[\r\n\s]/g, '');
        content = Buffer.from(cleanBase64, 'base64');
      } else if (contentTransferEncoding.toLowerCase() === 'quoted-printable') {
        content = Buffer.from(decodeQuotedPrintable(body));
      } else {
        content = Buffer.from(body);
      }

      result.attachments.push({
        filename,
        mimeType,
        content,
        contentId,
        isInline,
      });
    } else if (contentType.startsWith('text/plain')) {
      // Text body
      let textContent = body;
      if (contentTransferEncoding.toLowerCase() === 'base64') {
        textContent = Buffer.from(body.replace(/[\r\n\s]/g, ''), 'base64').toString('utf-8');
      } else if (contentTransferEncoding.toLowerCase() === 'quoted-printable') {
        textContent = decodeQuotedPrintable(body);
      }
      result.textBody = cleanBodyText(textContent);
    } else if (contentType.startsWith('text/html')) {
      // HTML body
      let htmlContent = body;
      if (contentTransferEncoding.toLowerCase() === 'base64') {
        htmlContent = Buffer.from(body.replace(/[\r\n\s]/g, ''), 'base64').toString('utf-8');
      } else if (contentTransferEncoding.toLowerCase() === 'quoted-printable') {
        htmlContent = decodeQuotedPrintable(body);
      }
      result.htmlBody = htmlContent;
    }
  }

  // If no text body but we have HTML, extract text from HTML
  if (!result.textBody && result.htmlBody) {
    result.textBody = htmlToText(result.htmlBody);
  }

  // If still no body, use the raw email minus obvious base64 blocks
  if (!result.textBody) {
    result.textBody = removeBase64Blocks(rawEmail);
  }

  return result;
}

/**
 * Store attachments in MinIO and create DB records (productDb - message_attachments table)
 */
export async function storeAttachments(params: {
  tenantId: string;
  messageId: string;  // This is the conversation message ID from productDb
  attachments: ParsedAttachment[];
}): Promise<StoredAttachment[]> {
  const { tenantId, messageId, attachments } = params;
  const stored: StoredAttachment[] = [];

  for (const attachment of attachments) {
    try {
      // Generate unique ID and storage key
      const id = generateId();
      const timestamp = Date.now();
      const safeFilename = sanitizeFilename(attachment.filename);
      const storageKey = `${tenantId}/${timestamp}-${id}-${safeFilename}`;

      // Upload to MinIO
      await minioClient.putObject(
        BUCKET,
        storageKey,
        attachment.content,
        attachment.content.length,
        { 'Content-Type': attachment.mimeType }
      );

      // Create DB record in productDb message_attachments table
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

      console.log(`[AttachmentParser] Stored attachment: ${attachment.filename} (${attachment.mimeType}, ${attachment.content.length} bytes)`);
    } catch (error) {
      console.error(`[AttachmentParser] Failed to store attachment ${attachment.filename}:`, error);
    }
  }

  return stored;
}

// Helper functions

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractHeader(headers: string, name: string): string | null {
  const regex = new RegExp(`^${name}:\\s*(.+)`, 'im');
  const match = headers.match(regex);
  return match ? match[1].trim() : null;
}

function extractFilename(disposition: string, contentType: string): string | null {
  // Try Content-Disposition first
  let match = disposition.match(/filename\*?=(?:UTF-8'')?["']?([^"';\r\n]+)/i);
  if (match) return decodeURIComponent(match[1]);

  // Try Content-Type
  match = contentType.match(/name\*?=(?:UTF-8'')?["']?([^"';\r\n]+)/i);
  if (match) return decodeURIComponent(match[1]);

  return null;
}

function isAttachmentType(contentType: string): boolean {
  const type = contentType.toLowerCase();
  return type.startsWith('application/pdf') ||
         type.startsWith('image/') ||
         type.startsWith('audio/') ||
         type.startsWith('video/') ||
         type.includes('octet-stream');
}

function decodeQuotedPrintable(str: string): string {
  return str
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => 
      String.fromCharCode(parseInt(hex, 16))
    );
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
  // Remove base64-like blocks (long strings without spaces)
  return text
    .replace(/[A-Za-z0-9+/=]{100,}/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function removeBase64Blocks(text: string): string {
  // Remove obvious base64 content
  const lines = text.split('\n');
  const cleanLines = lines.filter(line => {
    const trimmed = line.trim();
    // Skip lines that look like base64 (long alphanumeric strings)
    if (trimmed.length > 76 && /^[A-Za-z0-9+/=]+$/.test(trimmed)) {
      return false;
    }
    return true;
  });
  return cleanLines.join('\n').trim();
}

function sanitizeFilename(filename: string): string {
  return filename
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .substring(0, 100);
}

function generateId(): string {
  return 'att_' + randomBytes(12).toString('hex');
}

export default {
  parseMimeEmail,
  storeAttachments,
};
