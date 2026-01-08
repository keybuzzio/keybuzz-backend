/**
 * PH15-INBOUND-TO-CONVERSATION-01
 * Connection to keybuzz product database (for Inbox conversations/messages)
 */
import { Pool } from 'pg';

// Use PRODUCT_DATABASE_URL for keybuzz DB, fallback to same host different DB
const PRODUCT_DB_URL = process.env.PRODUCT_DATABASE_URL || 
  process.env.DATABASE_URL?.replace('keybuzz_backend', 'keybuzz') ||
  'postgresql://keybuzz_api_dev:KeyBuzz_Dev_2026!@10.0.0.10:5432/keybuzz';

const pool = new Pool({
  connectionString: PRODUCT_DB_URL,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

export const productDb = {
  query: (text: string, params?: any[]) => pool.query(text, params),
  getClient: () => pool.connect(),
};

export default productDb;
