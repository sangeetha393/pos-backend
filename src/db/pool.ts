import { Pool } from "pg";
import { ensureCoreSchema } from "../ops/schema";

/**
 * Shared PostgreSQL pool. Non-null only after `initDatabase()` connects and applies schema successfully.
 */
export let pool: Pool | null = null;

/** Set when DATABASE_URL is set but connection or schema init fails (for /api/ops/status). */
export let lastPostgresInitError: string | null = null;

/** True if `.env` has DATABASE_URL (desired Postgres use). */
export function isPostgresConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL?.trim());
}

/** True if Postgres is actually connected and ready for queries. */
export function isPostgresLive(): boolean {
  return pool !== null;
}

export function getPool(): Pool {
  if (!isPostgresLive()) {
    throw new Error(
      "PostgreSQL pool is not available. Check DATABASE_URL, ensure PostgreSQL is running, or remove DATABASE_URL to use JSON file mode."
    );
  }
  return pool!;
}

export function getDb(): Pool {
  return getPool();
}

/**
 * Connects and applies core schema. Never throws: on failure, pool stays null and the API falls back to files.
 */
export async function initDatabase(): Promise<void> {
  if (!isPostgresConfigured()) {
    lastPostgresInitError = null;
    console.warn("[db] DATABASE_URL not set — using JSON file persistence where applicable.");
    return;
  }

  const connectionString = process.env.DATABASE_URL!.trim();

  let candidate: Pool | null = null;
  try {
    candidate = new Pool({
      connectionString,
      max: 20,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000
    });

    candidate.on("error", (err) => {
      console.error("[db] Unexpected error on idle PostgreSQL client:", err.message);
    });

    const client = await candidate.connect();
    try {
      await client.query("SELECT 1 AS ok");
    } finally {
      client.release();
    }

    await ensureCoreSchema(candidate);
    pool = candidate;
    candidate = null;
    lastPostgresInitError = null;
    console.log("[db] PostgreSQL pool ready (core schema applied).");
  } catch (e) {
    if (candidate) {
      try {
        await candidate.end();
      } catch {
        /* ignore */
      }
      candidate = null;
    }
    const msg = e instanceof Error ? e.message : String(e);
    lastPostgresInitError = msg;
    console.error("[db] PostgreSQL unavailable — continuing with JSON/files. Reason:", msg);
    console.error(
      "[db] Tip: start PostgreSQL, fix DATABASE_URL in backend/.env, or comment DATABASE_URL out for file-only mode."
    );
  }
}

export async function closeDatabase(): Promise<void> {
  if (!pool) return;
  await pool.end();
  pool = null;
  console.log("[db] PostgreSQL pool closed");
}
