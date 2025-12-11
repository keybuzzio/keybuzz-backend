import { Pool } from "pg";
import { env } from "../config/env";

export const db = new Pool({
  connectionString: env.DATABASE_URL,
});

export async function testDbConnection(): Promise<boolean> {
  const res = await db.query("SELECT 1 as ok");
  return res.rows[0]?.ok === 1;
}

