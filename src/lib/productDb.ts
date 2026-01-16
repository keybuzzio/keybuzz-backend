/**
 * PH15-INBOUND-TO-CONVERSATION-01
 * PH-SEC-DB-CREDS-VAULT-ONLY-02: No hardcoded credentials
 * Connection to keybuzz product database (for Inbox conversations/messages)
 */
import { Pool } from 'pg';

// SECURITY: Use only env vars - NEVER hardcode credentials
// Expected env vars: PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE
// Or: PRODUCT_DATABASE_URL (full connection string from Vault/ESO)

function getProductDbUrl(): string {
  // Priority 1: Explicit PRODUCT_DATABASE_URL
  if (process.env.PRODUCT_DATABASE_URL) {
    return process.env.PRODUCT_DATABASE_URL;
  }
  
  // Priority 2: Standard PG env vars (injected by K8s secret from ESO)
  const host = process.env.PGHOST;
  const port = process.env.PGPORT || '5432';
  const user = process.env.PGUSER;
  const password = process.env.PGPASSWORD;
  const database = process.env.PGDATABASE || 'keybuzz';
  
  if (host && user && password) {
    return `postgresql://${user}:${encodeURIComponent(password)}@${host}:${port}/${database}`;
  }
  
  // Priority 3: DATABASE_URL with DB name substitution
  if (process.env.DATABASE_URL) {
    return process.env.DATABASE_URL.replace('keybuzz_backend', 'keybuzz');
  }
  
  // FAIL FAST: No credentials available - crash at boot
  console.error('[FATAL] Missing database credentials. Required: PRODUCT_DATABASE_URL or PGHOST+PGUSER+PGPASSWORD');
  console.error('[FATAL] Credentials must come from Vault/ESO, not hardcoded.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: getProductDbUrl(),
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

// Log connection info (without password)
const dbUrl = getProductDbUrl();
const safeUrl = dbUrl.replace(/:[^:@]+@/, ':***@');
console.log(`[ProductDB] Connecting to: ${safeUrl}`);

export const productDb = {
  query: (text: string, params?: any[]) => pool.query(text, params),
  getClient: () => pool.connect(),
};

export default productDb;
