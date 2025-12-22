import * as jwt from 'jsonwebtoken';
import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';

// Load .env.production
const envPath = path.join(__dirname, '.env.production');
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
}

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('❌ JWT_SECRET not found in .env.production');
  process.exit(1);
}

const payload = {
  sub: 'user_admin_test',
  tenantId: 'kbz_test',
  role: 'super_admin',
  email: 'admin@keybuzz.io',
  iat: Math.floor(Date.now() / 1000),
  exp: Math.floor(Date.now() / 1000) + (365 * 24 * 60 * 60) // 1 year
};

const token = jwt.sign(payload, JWT_SECRET);
console.log(token);

// Save to file
const tokenPath = '/opt/keybuzz/secrets/dev_jwt_admin.txt';
fs.writeFileSync(tokenPath, token, { mode: 0o600 });
console.error(`✅ Token saved to ${tokenPath}`);

