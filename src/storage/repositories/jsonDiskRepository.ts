/**
 * Data access layer for JSON-on-disk documents (tenant + global files).
 * Routes and domain code should use this instead of raw fs for the same guarantees:
 * atomic writes, recovery helpers, queued persistence. PostgreSQL mode bypasses these paths.
 */
import { DATA_DIR } from "../../paths";
import {
  readJsonWithRecoverySync,
  enqueueJsonWrite,
  writeJsonValueAtomicSync,
  flushAllJsonWriteQueues,
  readJsonArrayFileOrEmpty,
  runStartupJsonRecovery,
  startBackupScheduler
} from "../jsonPersistence";

export const jsonDiskRepository = {
  dataDir: DATA_DIR,

  readWithRecovery: readJsonWithRecoverySync,
  readArrayOrEmpty: readJsonArrayFileOrEmpty,

  /** Async-safe; use when handler must not block the event loop on large files. */
  persistQueued: enqueueJsonWrite,

  /** Same-process critical path (small files); still atomic rename. */
  persistSync: writeJsonValueAtomicSync,

  drainWriteQueue: flushAllJsonWriteQueues,

  /** Call once at process start (see index.ts). */
  runStartupRecovery: runStartupJsonRecovery,

  /** Periodic daily snapshots under .backups/daily (see index.ts). */
  startBackupScheduler
};
