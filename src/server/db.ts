import { Pool, type PoolClient } from "pg";

const globalDb = globalThis as unknown as { linkdPool?: Pool };
const schema = process.env.DATABASE_SCHEMA ?? "public";
if (!/^[a-z][a-z0-9_]*$/.test(schema))
  throw new Error("Invalid database schema");
export const db =
  globalDb.linkdPool ??
  new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 10,
    connectionTimeoutMillis: 5000,
    options: `-c search_path=${schema}`,
  });
if (process.env.NODE_ENV !== "production") globalDb.linkdPool = db;
export type Connection = Pick<PoolClient, "query">;
export async function transaction<T>(fn: (tx: PoolClient) => Promise<T>) {
  const tx = await db.connect();
  try {
    await tx.query("BEGIN");
    const result = await fn(tx);
    await tx.query("COMMIT");
    return result;
  } catch (error) {
    await tx.query("ROLLBACK");
    throw error;
  } finally {
    tx.release();
  }
}
