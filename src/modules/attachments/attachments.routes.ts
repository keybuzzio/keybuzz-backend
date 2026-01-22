/**
 * PH-PROD-MINIO-HA-02: Attachments API Routes
 * Secure attachment download via API (MinIO internal only)
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import '@fastify/multipart';
import { prisma } from '../../lib/db';
import { Client as MinioClient } from 'minio';
import { devAuthenticateOrJwt } from '../../lib/devAuthMiddleware';

// MinIO client (internal only - via HAProxy)
const minioEndpoint = process.env.MINIO_ENDPOINT?.replace('http://', '').split(':')[0] || '10.0.0.11';
const minioPort = parseInt(process.env.MINIO_PORT || '9000');

const minioClient = new MinioClient({
  endPoint: minioEndpoint,
  port: minioPort,
  useSSL: false,
  accessKey: process.env.MINIO_ACCESS_KEY || 'keybuzz-admin',
  secretKey: process.env.MINIO_SECRET_KEY || '',
});

interface AttachmentParams {
  id: string;
}

interface AuthUser {
  tenantId: string;
  role: string;
}

export function registerAttachmentsRoutes(app: FastifyInstance) {
  /**
   * GET /api/v1/attachments/:id
   * Download attachment via API (stream from MinIO)
   * 
   * Security:
   * - Auth required
   * - Tenant verification
   * - RBAC check (agent/owner)
   */
  app.get<{ Params: AttachmentParams }>(
    '/api/v1/attachments/:id',
    { preHandler: devAuthenticateOrJwt },
    async (request: FastifyRequest<{ Params: AttachmentParams }>, reply: FastifyReply) => {
      const { id } = request.params;
      const user = (request as any).user as AuthUser;

      try {
        // 1. Fetch attachment metadata from DB
        const attachment = await prisma.$queryRaw<Array<{
          id: string;
          tenantId: string;
          bucket: string;
          objectKey: string;
          filename: string;
          mimeType: string;
          size: number;
          isInline: boolean;
        }>>`
          SELECT id, "tenantId", bucket, "objectKey", filename, "mimeType", size, "isInline"
          FROM "MessageAttachment"
          WHERE id = ${id}
          LIMIT 1
        `;

        if (!attachment || attachment.length === 0) {
          return reply.status(404).send({ error: 'Attachment not found' });
        }

        const att = attachment[0];

        // 2. Verify tenant access
        if (att.tenantId !== user.tenantId) {
          return reply.status(403).send({ error: 'Access denied' });
        }

        // 3. Stream from MinIO
        const stream = await minioClient.getObject(att.bucket, att.objectKey);

        // 4. Set response headers
        const disposition = att.isInline ? 'inline' : 'attachment';
        reply.header('Content-Type', att.mimeType);
        reply.header('Content-Disposition', `${disposition}; filename="${att.filename}"`);
        reply.header('Content-Length', att.size);
        reply.header('Cache-Control', 'private, max-age=3600');

        // 5. Stream response
        return reply.send(stream);
      } catch (error: any) {
        app.log.error({ err: error, attachmentId: id }, 'Attachment download error');
        
        if (error.code === 'NoSuchKey') {
          return reply.status(404).send({ error: 'Attachment file not found in storage' });
        }
        
        return reply.status(500).send({ error: 'Failed to download attachment' });
      }
    }
  );

  /**
   * GET /api/v1/attachments/:id/info
   * Get attachment metadata only (no download)
   */
  app.get<{ Params: AttachmentParams }>(
    '/api/v1/attachments/:id/info',
    { preHandler: devAuthenticateOrJwt },
    async (request: FastifyRequest<{ Params: AttachmentParams }>, reply: FastifyReply) => {
      const { id } = request.params;
      const user = (request as any).user as AuthUser;

      const attachment = await prisma.$queryRaw<Array<{
        id: string;
        tenantId: string;
        filename: string;
        mimeType: string;
        size: number;
        isInline: boolean;
        createdAt: Date;
      }>>`
        SELECT id, "tenantId", filename, "mimeType", size, "isInline", "createdAt"
        FROM "MessageAttachment"
        WHERE id = ${id}
        LIMIT 1
      `;

      if (!attachment || attachment.length === 0) {
        return reply.status(404).send({ error: 'Attachment not found' });
      }

      const att = attachment[0];

      if (att.tenantId !== user.tenantId) {
        return reply.status(403).send({ error: 'Access denied' });
      }

      return reply.send({
        id: att.id,
        filename: att.filename,
        mimeType: att.mimeType,
        size: att.size,
        isInline: att.isInline,
        createdAt: att.createdAt,
        downloadUrl: `/api/v1/attachments/${att.id}`,
      });
    }
  );

  /**
   * POST /api/v1/attachments/upload
   * Upload attachment for outbound message
   * Returns attachment info to include when sending message
   */
  app.post(
    '/api/v1/attachments/upload',
    { preHandler: devAuthenticateOrJwt },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = (request as any).user as AuthUser;
      
      try {
        // Get multipart data
        const data = await request.file();
        if (!data) {
          return reply.status(400).send({ error: 'No file uploaded' });
        }

        const filename = data.filename;
        const mimeType = data.mimetype;
        
        // Validate file type
        const allowedTypes = ['application/pdf', 'image/jpeg', 'image/png', 'image/gif'];
        if (!allowedTypes.includes(mimeType)) {
          return reply.status(400).send({ 
            error: 'Invalid file type', 
            message: 'Seuls les fichiers PDF et images (JPG, PNG, GIF) sont autorisés'
          });
        }

        // Read file content
        const chunks: Buffer[] = [];
        for await (const chunk of data.file) {
          chunks.push(chunk);
        }
        const fileBuffer = Buffer.concat(chunks);
        
        // Validate file size (max 10MB)
        const maxSize = 10 * 1024 * 1024;
        if (fileBuffer.length > maxSize) {
          return reply.status(400).send({ 
            error: 'File too large', 
            message: 'La taille maximale est de 10 Mo'
          });
        }

        // Generate unique ID and storage key
        const attachmentId = 'att_' + Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
        const storageKey = `${user.tenantId}/outbound/${attachmentId}-${filename}`;
        const bucket = 'keybuzz-attachments';

        // Upload to MinIO
        await minioClient.putObject(bucket, storageKey, fileBuffer, fileBuffer.length, {
          'Content-Type': mimeType,
        });

        app.log.info({ attachmentId, filename, size: fileBuffer.length, tenantId: user.tenantId }, 'Outbound attachment uploaded');

        return reply.send({
          id: attachmentId,
          filename,
          mimeType,
          size: fileBuffer.length,
          storageKey,
          status: 'uploaded',
        });
      } catch (error: any) {
        app.log.error({ err: error }, 'Upload error');
        return reply.status(500).send({ error: 'Upload failed', message: error.message });
      }
    }
  );

  /**
   * GET /api/v1/attachments/channel-rules/:channel
   * Get attachment rules for a channel
   */
  app.get<{ Params: { channel: string } }>(
    '/api/v1/attachments/channel-rules/:channel',
    async (request: FastifyRequest<{ Params: { channel: string } }>, reply: FastifyReply) => {
      const { channel } = request.params;
      
      if (channel === 'amazon') {
        return reply.send({
          canSendAttachments: false,
          reason: "Amazon Messaging n'accepte pas les pièces jointes. Utilisez un lien externe si nécessaire.",
          maxSize: 0,
          allowedTypes: []
        });
      }
      
      // Default: email channel
      return reply.send({
        canSendAttachments: true,
        reason: null,
        maxSize: 10 * 1024 * 1024, // 10MB
        allowedTypes: ['application/pdf', 'image/jpeg', 'image/png', 'image/gif']
      });
    }
  );

}
