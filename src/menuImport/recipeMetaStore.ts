import fs from "fs";
import path from "path";
import { DATA_DIR } from "../paths";
import { readJsonWithRecoverySync, writeJsonValueAtomicSync } from "../storage/jsonPersistence";
import type { RecipeProductMeta } from "./types";

const FILE = path.join(DATA_DIR, "recipe-product-meta.json");

export function loadRecipeProductMeta(): RecipeProductMeta[] {
  const raw = readJsonWithRecoverySync(DATA_DIR, FILE, [] as unknown[], (x): x is unknown[] =>
    Array.isArray(x)
  );
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is RecipeProductMeta => {
    if (!x || typeof x !== "object") return false;
    const o = x as Record<string, unknown>;
    return typeof o.productId === "string" && typeof o.confidence === "number";
  });
}

export function saveRecipeProductMeta(list: RecipeProductMeta[]): void {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    writeJsonValueAtomicSync(FILE, list);
  } catch (e) {
    console.error("saveRecipeProductMeta:", e);
  }
}

export function upsertRecipeMeta(entries: RecipeProductMeta[]): RecipeProductMeta[] {
  const cur = loadRecipeProductMeta();
  const byId = new Map(cur.map((m) => [m.productId, m]));
  for (const e of entries) {
    byId.set(e.productId, e);
  }
  const out = [...byId.values()].sort((a, b) => a.productId.localeCompare(b.productId));
  saveRecipeProductMeta(out);
  return out;
}

export function removeRecipeMetaForProduct(productId: string): void {
  const cur = loadRecipeProductMeta().filter((m) => m.productId !== productId);
  saveRecipeProductMeta(cur);
}
