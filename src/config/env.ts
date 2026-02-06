import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.string().default("development"),
  PORT: z
    .string()
    .default("4000")
    .transform((val) => Number(val))
    .pipe(z.number().int().positive()),
  DATABASE_URL: z
    .string()
    .default(""),
  JWT_SECRET: z.string().min(1).default("CHANGE_ME_SECRET"),
  KEYBUZZ_SUPERADMIN_EMAIL: z.string().email().default("admin@keybuzz.io"),
  KEYBUZZ_SUPERADMIN_PASSWORD: z.string().min(1).default("change-me"),
  KEYBUZZ_AI_PROVIDER: z.string().optional().default("mock"),
  KEYBUZZ_AI_BASE_URL: z.string().url().optional(),
  KEYBUZZ_AI_API_KEY: z.string().optional(),
  
  // PH11-05D.3: Auto-send AI replies (feature flags)
  KEYBUZZ_AI_AUTOSEND_ENABLED: z.string().default("false"),
  KEYBUZZ_AI_AUTOSEND_MAX_PER_TICKET: z
    .string()
    .default("3")
    .transform((val) => Number(val))
    .pipe(z.number().int().positive()),
  KEYBUZZ_AI_AUTOSEND_COOLDOWN_MINUTES: z
    .string()
    .default("10")
    .transform((val) => Number(val))
    .pipe(z.number().int().positive()),
  
  // PH11-06B: Amazon SP-API OAuth
  AMAZON_SPAPI_CLIENT_ID: z.string().optional(),
  AMAZON_SPAPI_CLIENT_SECRET: z.string().optional(),
  AMAZON_SPAPI_REDIRECT_URI: z.string().url().optional(),
  AMAZON_SPAPI_LWA_OAUTH_URL: z.string().url().default("https://api.amazon.com/auth/o2/token"),
  AMAZON_SPAPI_APP_ID: z.string().optional(),
  
  // Vault
  VAULT_ADDR: z.string().url().optional(),
  VAULT_TOKEN: z.string().optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("❌ Invalid environment variables", parsed.error.format());
  throw new Error("Invalid environment variables");
}

export const env = parsed.data;

