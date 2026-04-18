/**
 * PostgreSQL access for the POS backend.
 * - Call `initDatabase()` once at process startup (after `dotenv.config()`).
 *  - Import `pool` or use `getPool()` for queries elsewhere.
 */
export {
  pool,
  getPool,
  getDb,
  initDatabase,
  closeDatabase,
  isPostgresConfigured,
  isPostgresLive
} from "./pool";
export { initPostgresSchema, loadCollectionBodies, replaceCollectionBodies } from "./postgresCollections";
