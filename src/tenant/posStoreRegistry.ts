import fs from "fs";
import path from "path";
import { DATA_DIR } from "../paths";
import { isPostgresLive } from "../db/pool";
import { enqueueJsonWrite, readJsonWithRecoverySync } from "../storage/jsonPersistence";

export const STORES_ROOT_DIR = path.join(DATA_DIR, "stores");

/** Legacy single-tenant demo admin id — existing menu/orders without storeId migrate here. */
export const LEGACY_DEFAULT_STORE_ID = "U1";

export function storeDir(storeId: string): string {
  return path.join(STORES_ROOT_DIR, sanitizeStoreId(storeId));
}

export function sanitizeStoreId(raw: string): string {
  const s = String(raw || "").trim();
  if (!s || s.includes("..") || s.includes("/") || s.includes("\\")) return LEGACY_DEFAULT_STORE_ID;
  return s.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || LEGACY_DEFAULT_STORE_ID;
}

export function tenantPath(storeId: string, filename: string): string {
  return path.join(storeDir(storeId), filename);
}

function ensureDir(storeId: string): void {
  fs.mkdirSync(storeDir(storeId), { recursive: true });
}

function copyIfMissing(storeId: string, filename: string, legacyPath: string): void {
  const dest = tenantPath(storeId, filename);
  if (fs.existsSync(dest)) return;
  if (fs.existsSync(legacyPath)) {
    ensureDir(storeId);
    try {
      fs.copyFileSync(legacyPath, dest);
      console.log(`[tenant] Migrated ${filename} → stores/${sanitizeStoreId(storeId)}/`);
    } catch (e) {
      console.error(`[tenant] Copy ${filename} failed:`, e);
    }
  }
}

/**
 * First time a store folder is used: seed from legacy flat `data/*.json` if present (one-time per file).
 */
export function migrateLegacyFilesIntoStore(storeId: string, legacyFiles: { name: string; path: string }[]): void {
  if (isPostgresLive()) return;
  const sid = sanitizeStoreId(storeId);
  ensureDir(sid);
  for (const { name, path: src } of legacyFiles) {
    copyIfMissing(sid, name, src);
  }
}

export function readJsonArray<T>(file: string, fallback: T[]): T[] {
  return readJsonWithRecoverySync(
    DATA_DIR,
    file,
    fallback,
    (v): v is T[] => Array.isArray(v)
  );
}

/** Async-safe atomic writes; do not rely on immediate flush for same-tick reads in other processes. */
export function writeJsonFile(file: string, data: unknown): void {
  void enqueueJsonWrite(file, data).catch(() => undefined);
}
