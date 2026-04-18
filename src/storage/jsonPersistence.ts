/**
 * Production-safe JSON file persistence: atomic writes, serialized async queue per file,
 * optional recovery from daily backups. Keeps paths as strings for future DB migration.
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";

const writeChains = new Map<string, Promise<void>>();

/** Root-relative backup mirror: <dataDir>/.backups/daily/YYYY-MM-DD/<relativePath> */
export function backupDailyRoot(dataDir: string): string {
  return path.join(dataDir, ".backups", "daily");
}

export function writeJsonAtomicSync(absPath: string, jsonText: string): void {
  const dir = path.dirname(absPath);
  fs.mkdirSync(dir, { recursive: true });
  const base = path.basename(absPath);
  const tmp = path.join(
    dir,
    `.${base}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`
  );
  try {
    fs.writeFileSync(tmp, jsonText, "utf-8");
    fs.renameSync(tmp, absPath);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw e;
  }
}

export function writeJsonValueAtomicSync(absPath: string, data: unknown, pretty = true): void {
  const text = pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data);
  writeJsonAtomicSync(absPath, text);
}

/**
 * Serialize all writes to the same file so async handlers never interleave corrupt output.
 */
export function enqueueJsonWrite(absPath: string, data: unknown, pretty = true): Promise<void> {
  const prev = writeChains.get(absPath) ?? Promise.resolve();
  const next = prev.then(() => {
    writeJsonValueAtomicSync(absPath, data, pretty);
  });
  writeChains.set(absPath, next);
  next.catch((err) => {
    console.error(`[storage] enqueueJsonWrite failed: ${absPath}`, err);
  });
  void next.finally(() => {
    if (writeChains.get(absPath) === next) {
      writeChains.delete(absPath);
    }
  });
  return next;
}

/** Await every queued JSON write (graceful shutdown). */
export async function flushAllJsonWriteQueues(maxWaitMs = 60_000): Promise<void> {
  const deadline = Date.now() + maxWaitMs;
  while (writeChains.size > 0) {
    if (Date.now() > deadline) {
      console.warn(
        `[storage] flushAllJsonWriteQueues: timeout with ${writeChains.size} file(s) still queued`
      );
      return;
    }
    const batch = [...writeChains.values()];
    await Promise.all(batch.map((p) => p.catch(() => undefined)));
  }
}

function isInsideBackups(rel: string): boolean {
  const norm = rel.split(path.sep).join("/");
  return norm.startsWith(".backups/") || norm === ".backups";
}

export function findLatestBackupForFile(dataDir: string, absPath: string): string | null {
  const rel = path.relative(dataDir, absPath);
  if (!rel || rel.startsWith("..") || isInsideBackups(rel)) return null;
  const backupRoot = backupDailyRoot(dataDir);
  if (!fs.existsSync(backupRoot)) return null;
  let days: string[];
  try {
    days = fs
      .readdirSync(backupRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(d.name))
      .map((d) => d.name)
      .sort()
      .reverse();
  } catch {
    return null;
  }
  for (const day of days) {
    const cand = path.join(backupRoot, day, rel);
    if (fs.existsSync(cand)) return cand;
  }
  return null;
}

export function readJsonWithRecoverySync<T>(
  dataDir: string,
  absPath: string,
  fallback: T,
  guard?: (v: unknown) => v is T
): T {
  const tryParse = (raw: string): unknown => JSON.parse(raw);

  const readMain = (): unknown | null => {
    try {
      if (!fs.existsSync(absPath)) return null;
      return tryParse(fs.readFileSync(absPath, "utf-8"));
    } catch (e) {
      console.error(`[storage] read/parse failed ${absPath}`, e);
      return null;
    }
  };

  let parsed: unknown | null = readMain();
  if (parsed != null && (!guard || guard(parsed))) {
    return parsed as T;
  }

  const backup = findLatestBackupForFile(dataDir, absPath);
  if (backup) {
    try {
      const raw = fs.readFileSync(backup, "utf-8");
      parsed = tryParse(raw);
      if (parsed != null && (!guard || guard(parsed))) {
        try {
          fs.mkdirSync(path.dirname(absPath), { recursive: true });
          fs.copyFileSync(backup, absPath);
          console.warn(`[storage] restored ${absPath} from backup ${backup}`);
        } catch (copyErr) {
          console.error(`[storage] could not copy backup to main`, copyErr);
        }
        return parsed as T;
      }
    } catch (e) {
      console.error(`[storage] backup read failed ${backup}`, e);
    }
  }

  return fallback;
}

function walkJsonFiles(dir: string, dataDir: string, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    const rel = path.relative(dataDir, full).split(path.sep).join("/");
    if (ent.isDirectory()) {
      if (ent.name === ".backups") continue;
      walkJsonFiles(full, dataDir, out);
    } else if (ent.isFile() && ent.name.endsWith(".json")) {
      if (!isInsideBackups(rel)) out.push(full);
    }
  }
}

/** Validate JSON files under data root; restore from latest daily backup when corrupt. */
export function runStartupJsonRecovery(dataDir: string): void {
  if (!fs.existsSync(dataDir)) return;
  const files: string[] = [];
  walkJsonFiles(dataDir, dataDir, files);
  for (const absPath of files) {
    try {
      const raw = fs.readFileSync(absPath, "utf-8");
      JSON.parse(raw);
    } catch {
      const backup = findLatestBackupForFile(dataDir, absPath);
      if (backup) {
        try {
          fs.copyFileSync(backup, absPath);
          console.warn(`[startup recovery] ${absPath} ← ${backup}`);
        } catch (e) {
          console.error(`[startup recovery] failed ${absPath}`, e);
        }
      } else {
        console.error(`[startup recovery] corrupt and no backup: ${absPath}`);
      }
    }
  }
}

function localYYYYMMDD(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function copyJsonTreeForBackup(dataDir: string, destDayDir: string): void {
  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === ".backups") continue;
        walk(full);
      } else if (ent.isFile() && ent.name.endsWith(".json")) {
        const rel = path.relative(dataDir, full);
        if (rel.startsWith("..")) continue;
        const dest = path.join(destDayDir, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(full, dest);
      }
    }
  }
  walk(dataDir);
}

let lastBackupDay: string | null = null;

export function runDailyBackupIfNeeded(dataDir: string): void {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
  } catch {
    return;
  }
  const today = localYYYYMMDD(new Date());
  if (lastBackupDay === today) return;
  const dest = path.join(backupDailyRoot(dataDir), today);
  try {
    fs.mkdirSync(dest, { recursive: true });
    copyJsonTreeForBackup(dataDir, dest);
    lastBackupDay = today;
    console.log(`[storage] daily JSON backup → ${dest}`);
  } catch (e) {
    console.error("[storage] daily backup failed:", e);
  }
}

export function startBackupScheduler(dataDir: string, intervalMs = 60 * 60 * 1000): NodeJS.Timeout {
  runDailyBackupIfNeeded(dataDir);
  return setInterval(() => runDailyBackupIfNeeded(dataDir), intervalMs);
}

/**
 * Load a JSON array file via the same recovery path as object snapshots (backup → restore).
 */
export function readJsonArrayFileOrEmpty(dataDir: string, absPath: string): unknown[] {
  return readJsonWithRecoverySync(dataDir, absPath, [], (v): v is unknown[] => Array.isArray(v));
}
