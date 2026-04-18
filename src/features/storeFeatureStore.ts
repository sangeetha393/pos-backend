import fs from "fs";
import path from "path";
import bcrypt from "bcryptjs";
import { DATA_DIR } from "../paths";
import { sanitizeStoreId, STORES_ROOT_DIR } from "../tenant/posStoreRegistry";
import {
  type StoreFeatures,
  mergeStoreFeatures,
  defaultStoreFeatures,
  STORE_FEATURE_KEYS
} from "./storeFeatureModel";

const FILE = path.join(DATA_DIR, "store-features.json");
const AUDIT = path.join(DATA_DIR, "store-features-audit.jsonl");

type DiskShape = Record<string, Partial<StoreFeatures> | undefined>;

function readDisk(): DiskShape {
  try {
    const raw = fs.readFileSync(FILE, "utf-8");
    const p = JSON.parse(raw) as unknown;
    return p && typeof p === "object" ? (p as DiskShape) : {};
  } catch {
    return {};
  }
}

function writeDisk(data: DiskShape): void {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2), "utf-8");
}

function appendAudit(line: Record<string, unknown>): void {
  try {
    fs.appendFileSync(AUDIT, JSON.stringify(line) + "\n", "utf-8");
  } catch (e) {
    console.error("[store-features] audit write failed", e);
  }
}

export function getStoreFeaturesForStore(storeId: string): StoreFeatures {
  const sid = sanitizeStoreId(storeId);
  const disk = readDisk();
  const row = disk[sid];
  return mergeStoreFeatures(row as Partial<Record<string, unknown>>);
}

/** Remove one store row from disk (seller deletes a café tenant). */
export function removeStoreFeaturesRow(storeId: string): void {
  const sid = sanitizeStoreId(storeId);
  const disk = readDisk();
  if (!(sid in disk)) return;
  delete disk[sid];
  writeDisk(disk);
  appendAudit({
    ts: new Date().toISOString(),
    storeId: sid,
    changedBy: "super_admin",
    role: "super_admin",
    features: null,
    action: "tenant_removed"
  });
}

export function setStoreFeaturesForStore(
  storeId: string,
  next: Partial<StoreFeatures>,
  meta: { changedBy: string; role: string }
): StoreFeatures {
  const sid = sanitizeStoreId(storeId);
  const disk = readDisk();
  const current = mergeStoreFeatures(disk[sid] as Partial<Record<string, unknown>>);
  const merged: StoreFeatures = { ...current };
  for (const k of STORE_FEATURE_KEYS) {
    if (k in next && typeof next[k] === "boolean") merged[k] = next[k]!;
  }
  disk[sid] = merged;
  writeDisk(disk);
  appendAudit({
    ts: new Date().toISOString(),
    storeId: sid,
    changedBy: meta.changedBy,
    role: meta.role,
    features: merged
  });
  return merged;
}

/** Café tenant ids from `users.json` (admin accounts — same id as JSON `data/stores/<id>/` when file mode). */
function adminStoreIdsFromUsersFile(): string[] {
  const out: string[] = [];
  try {
    const raw = fs.readFileSync(path.join(DATA_DIR, "users.json"), "utf-8");
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return out;
    for (const row of arr) {
      if (!row || typeof row !== "object") continue;
      const o = row as Record<string, unknown>;
      if (o.role !== "admin") continue;
      const id = typeof o.id === "string" ? o.id.trim() : "";
      if (id) out.push(sanitizeStoreId(id));
    }
  } catch {
    /* ignore */
  }
  return out;
}

/**
 * Known store ids: folders under data/stores + keys in store-features.json + every café admin in users.json.
 * PostgreSQL mode often skips creating `data/stores/<id>/`, so admins must still appear here.
 */
export function listKnownStoreIds(): string[] {
  const ids = new Set<string>();
  const disk = readDisk();
  for (const k of Object.keys(disk)) {
    if (k.trim()) ids.add(sanitizeStoreId(k));
  }
  try {
    if (fs.existsSync(STORES_ROOT_DIR)) {
      for (const name of fs.readdirSync(STORES_ROOT_DIR)) {
        const p = path.join(STORES_ROOT_DIR, name);
        if (fs.statSync(p).isDirectory()) ids.add(sanitizeStoreId(name));
      }
    }
  } catch {
    /* ignore */
  }
  for (const id of adminStoreIdsFromUsersFile()) ids.add(id);
  return [...ids].sort();
}

export type StoreListEntry = { id: string; label: string };

/**
 * Same ids as {@link listKnownStoreIds}, with a readable label from café admin
 * (`storeName`, owner name, or email). Folders without a matching admin stay as id-only.
 */
export function listStoresWithLabels(): StoreListEntry[] {
  const ids = listKnownStoreIds();
  const byAdminId = new Map<string, { email?: string; storeName?: string; name?: string }>();
  try {
    const raw = fs.readFileSync(path.join(DATA_DIR, "users.json"), "utf-8");
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return ids.map((id) => ({ id, label: id }));
    for (const row of arr) {
      if (!row || typeof row !== "object") continue;
      const o = row as Record<string, unknown>;
      if (o.role !== "admin") continue;
      const id = typeof o.id === "string" ? o.id.trim() : "";
      if (!id) continue;
      byAdminId.set(sanitizeStoreId(id), {
        email: typeof o.email === "string" ? o.email : undefined,
        storeName: typeof o.storeName === "string" ? o.storeName : undefined,
        name: typeof o.name === "string" ? o.name : undefined
      });
    }
  } catch {
    /* ignore */
  }
  return ids.map((id) => {
    const u = byAdminId.get(id);
    if (u) {
      const primary = (u.storeName || u.name || "").trim();
      if (u.email) {
        if (primary && primary.toLowerCase() !== u.email.toLowerCase()) {
          return { id, label: `${primary} — ${u.email}` };
        }
        return { id, label: u.email };
      }
      return { id, label: primary || id };
    }
    return { id, label: `${id} (no linked café admin)` };
  });
}

/** Optional bcrypt PIN — set SUPER_ADMIN_PIN_HASH in env; omit to skip PIN check. */
export function verifySuperAdminPin(plainPin: string | undefined): boolean {
  const hash = process.env.SUPER_ADMIN_PIN_HASH?.trim();
  if (!hash) return true;
  if (!plainPin || typeof plainPin !== "string") return false;
  return bcrypt.compareSync(plainPin.trim(), hash);
}
