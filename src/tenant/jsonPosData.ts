/**
 * Per-hotel (per admin account) menu + inventory when using JSON files.
 * PostgreSQL mode uses a single shared synthetic store id __pg__ (not isolated).
 */
import fs from "fs";
import path from "path";
import { DATA_DIR } from "../paths";
import { isPostgresLive } from "../db/pool";
import {
  LEGACY_DEFAULT_STORE_ID,
  STORES_ROOT_DIR,
  migrateLegacyFilesIntoStore,
  sanitizeStoreId,
  readJsonArray,
  writeJsonFile,
  tenantPath
} from "./posStoreRegistry";
import { seedDefaultFloorPlan } from "../tables/floorPlan";
import { readJsonWithRecoverySync } from "../storage/jsonPersistence";

export const PG_SHARED_STORE_ID = "__pg__";

export type JsonPosStore = {
  storeId: string;
  products: unknown[];
  ingredients: unknown[];
  recipes: unknown[];
  /** Legacy: array of tables; current: `{ sections, tables }` floor plan document. */
  tables: unknown;
  settings: Record<string, unknown>;
  inventoryMap: Map<string, { productId: string; qty: number; unit: string; lowStock: number }>;
};

const cache = new Map<string, JsonPosStore>();

function readTablesJsonFile(file: string): unknown {
  return readJsonWithRecoverySync(
    DATA_DIR,
    file,
    null as unknown,
    (v): v is unknown => v !== null && typeof v === "object"
  );
}

const LEGACY_FILES = (root: string) => [
  { name: "products.json", path: path.join(root, "products.json") },
  { name: "ingredients.json", path: path.join(root, "ingredients.json") },
  { name: "recipes.json", path: path.join(root, "recipes.json") },
  { name: "settings.json", path: path.join(root, "settings.json") },
  { name: "product-inventory.json", path: path.join(root, "product-inventory.json") },
  { name: "tables.json", path: path.join(root, "tables.json") }
];

export function getOrCreateJsonPosStore(storeIdRaw: string): JsonPosStore {
  if (isPostgresLive()) {
    let g = cache.get(PG_SHARED_STORE_ID);
    if (g) return g;
    g = emptyStore(PG_SHARED_STORE_ID);
    cache.set(PG_SHARED_STORE_ID, g);
    return g;
  }
  const storeId = sanitizeStoreId(storeIdRaw);
  let s = cache.get(storeId);
  if (s) return s;
  fs.mkdirSync(STORES_ROOT_DIR, { recursive: true });
  migrateLegacyFilesIntoStore(storeId, LEGACY_FILES(DATA_DIR));

  const productsPath = tenantPath(storeId, "products.json");
  const ingPath = tenantPath(storeId, "ingredients.json");
  const recPath = tenantPath(storeId, "recipes.json");
  const settingsPath = tenantPath(storeId, "settings.json");
  const invPath = tenantPath(storeId, "product-inventory.json");
  const tablesPath = tenantPath(storeId, "tables.json");

  s = {
    storeId,
    products: readJsonArray(productsPath, []),
    ingredients: readJsonArray(ingPath, []),
    recipes: readJsonArray(recPath, []),
    tables: (readTablesJsonFile(tablesPath) as unknown[] | Record<string, unknown> | null) ?? [],
    settings: readJsonWithRecoverySync(
      DATA_DIR,
      settingsPath,
      {} as Record<string, unknown>,
      (v): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)
    ),
    inventoryMap: loadInventoryMap(invPath)
  };
  cache.set(storeId, s);
  return s;
}

function emptyStore(storeId: string): JsonPosStore {
  return {
    storeId,
    products: [],
    ingredients: [],
    recipes: [],
    tables: seedDefaultFloorPlan(),
    settings: {},
    inventoryMap: new Map()
  };
}

function loadInventoryMap(invPath: string): Map<string, { productId: string; qty: number; unit: string; lowStock: number }> {
  const rows = readJsonArray<Record<string, unknown>>(invPath, []);
  const m = new Map<string, { productId: string; qty: number; unit: string; lowStock: number }>();
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const productId = typeof row.productId === "string" ? row.productId.trim() : "";
    if (!productId) continue;
    m.set(productId, {
      productId,
      qty: Math.max(0, Number(row.qty) || 0),
      unit: typeof row.unit === "string" && row.unit.trim() ? row.unit.trim() : "pcs",
      lowStock: Math.max(0, Number(row.lowStock) || 10)
    });
  }
  return m;
}

export function persistJsonPosStore(store: JsonPosStore): void {
  if (isPostgresLive()) return;
  writeJsonFile(tenantPath(store.storeId, "products.json"), store.products);
  writeJsonFile(tenantPath(store.storeId, "ingredients.json"), store.ingredients);
  writeJsonFile(tenantPath(store.storeId, "recipes.json"), store.recipes);
  writeJsonFile(tenantPath(store.storeId, "tables.json"), store.tables as object);
  writeJsonFile(tenantPath(store.storeId, "settings.json"), store.settings);
  writeJsonFile(tenantPath(store.storeId, "product-inventory.json"), [...store.inventoryMap.values()]);
}

/** New hotel: seed empty store folder (admin id = store id). */
export function seedEmptyStoreFiles(storeIdRaw: string): void {
  if (isPostgresLive()) return;
  const storeId = sanitizeStoreId(storeIdRaw);
  if (cache.has(storeId)) return;
  fs.mkdirSync(storeDir(storeId), { recursive: true });
  const base = storeDir(storeId);
  for (const f of ["products.json", "ingredients.json", "recipes.json"]) {
    const p = path.join(base, f);
    if (!fs.existsSync(p)) writeJsonFile(p, []);
  }
  const tablesP = path.join(base, "tables.json");
  if (!fs.existsSync(tablesP)) writeJsonFile(tablesP, seedDefaultFloorPlan());
  const settingsP = path.join(base, "settings.json");
  if (!fs.existsSync(settingsP)) writeJsonFile(settingsP, {});
  const invP = path.join(base, "product-inventory.json");
  if (!fs.existsSync(invP)) writeJsonFile(invP, []);
  cache.delete(storeId);
}

function storeDir(storeId: string): string {
  return path.join(STORES_ROOT_DIR, sanitizeStoreId(storeId));
}

export function syncPgStoreIntoCache(store: JsonPosStore): void {
  cache.set(PG_SHARED_STORE_ID, store);
}
