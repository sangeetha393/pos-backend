import { getPool } from "./pool";

export { isPostgresConfigured, isPostgresLive } from "./pool";

/** Idempotent. Requires `initDatabase()` + `DATABASE_URL` (callers typically guard with isPostgresConfigured). */
export async function initPostgresSchema(): Promise<void> {
  const p = getPool();
  await p.query(`
    CREATE TABLE IF NOT EXISTS pos_collection_docs (
      collection VARCHAR(64) NOT NULL,
      doc_id VARCHAR(512) NOT NULL,
      body JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (collection, doc_id)
    );
  `);
  await p.query(
    `CREATE INDEX IF NOT EXISTS pos_collection_docs_collection_idx ON pos_collection_docs (collection);`
  );
}

export async function loadCollectionBodies(collection: string): Promise<unknown[]> {
  const p = getPool();
  const r = await p.query<{ body: unknown }>(
    `SELECT body FROM pos_collection_docs WHERE collection = $1 ORDER BY doc_id`,
    [collection]
  );
  return r.rows.map((x: { body: unknown }) => x.body);
}

export async function replaceCollectionBodies(
  collection: string,
  rows: { docId: string; body: unknown }[]
): Promise<void> {
  const p = getPool();
  const c = await p.connect();
  try {
    await c.query("BEGIN");
    await c.query(`DELETE FROM pos_collection_docs WHERE collection = $1`, [collection]);
    for (const row of rows) {
      await c.query(
        `INSERT INTO pos_collection_docs (collection, doc_id, body) VALUES ($1, $2, $3::jsonb)`,
        [collection, row.docId, JSON.stringify(row.body)]
      );
    }
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
