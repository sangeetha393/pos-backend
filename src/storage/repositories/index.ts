/**
 * Data access facade — persistence today is JSON files via `jsonPersistence` (atomic writes + backup).
 * Route handlers should prefer tenant helpers (`writeJsonFile`, `readJsonArray`) and order store APIs;
 * this module documents the boundary for a future PostgreSQL repository swap.
 */
export {
  enqueueJsonWrite,
  writeJsonValueAtomicSync,
  readJsonWithRecoverySync,
  readJsonArrayFileOrEmpty,
  runStartupJsonRecovery,
  runDailyBackupIfNeeded,
  startBackupScheduler,
  findLatestBackupForFile,
  flushAllJsonWriteQueues
} from "../jsonPersistence";
export { jsonDiskRepository } from "./jsonDiskRepository";
