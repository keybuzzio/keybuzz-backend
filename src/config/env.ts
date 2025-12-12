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
    .default("postgres://postgres:CHANGE_ME@10.0.0.10:5432/keybuzz_backend"),
  JWT_SECRET: z.string().min(1).default("CHANGE_ME_SECRET"),
  KEYBUZZ_SUPERADMIN_EMAIL: z.string().email().default("admin@keybuzz.io"),
  KEYBUZZ_SUPERADMIN_PASSWORD: z.string().min(1).default("change-me"),
  KEYBUZZ_AI_PROVIDER: z.string().optional().default("mock"),
  KEYBUZZ_AI_BASE_URL: z.string().url().optional(),
  KEYBUZZ_AI_API_KEY: z.string().optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("❌ Invalid environment variables", parsed.error.format());
  throw new Error("Invalid environment variables");
}

export const env = parsed.data;

