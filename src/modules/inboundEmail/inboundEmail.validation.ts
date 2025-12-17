/**
 * Validation schemas for Inbound Email endpoints
 * PH11-06B.5D fix
 */

import { z } from 'zod';

export const CreateConnectionSchema = z.object({
  marketplace: z.enum(['AMAZON', 'EBAY', 'CDISCOUNT', 'FNAC'], {
    message: 'marketplace must be AMAZON, EBAY, CDISCOUNT, or FNAC',
  }),
  countries: z.array(z.string().min(2).max(3)).min(1, 'At least one country is required'),
  tenantId: z.string().optional(), // Optional, will be validated based on role
});

export type CreateConnectionInput = z.infer<typeof CreateConnectionSchema>;

