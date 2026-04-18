import type { AiRecipeIngredient, ParsedMenuItem } from "./types";

/** Canonical units allowed by POS ingredients API. */
export type StorageUnit = "kg" | "pcs" | "litre";

/** Same rules as POS /api/ingredients — only these units are stored. */
export function normalizeIngredientUnitForPos(raw: string): StorageUnit | null {
  const u = raw.trim().toLowerCase();
  if (u === "l" || u === "ltr" || u === "liter" || u === "litre") return "litre";
  if (u === "kg" || u === "kilogram" || u === "kilograms") return "kg";
  if (u === "pc" || u === "piece" || u === "pieces" || u === "pcs") return "pcs";
  if (u === "kg" || u === "pcs" || u === "litre") return u as StorageUnit;
  return null;
}

/**
 * Normalize free-text units from AI into storage unit + multiplier to convert AI qty → storage qty.
 * e.g. 100 g + "grams" → 0.1 kg
 */
export function ingredientQtyToStorage(
  qty: number,
  unitRaw: string
): { qty: number; unit: StorageUnit } | null {
  if (!Number.isFinite(qty) || qty < 0) return null;
  const u = unitRaw.trim().toLowerCase();

  if (["kg", "kilogram", "kilograms"].includes(u)) return { qty, unit: "kg" };
  if (["g", "gram", "grams", "gm"].includes(u)) return { qty: qty / 1000, unit: "kg" };

  if (["l", "ltr", "liter", "litre", "liters", "litres"].includes(u)) return { qty, unit: "litre" };
  if (["ml", "milliliter", "millilitre", "milliliters"].includes(u)) return { qty: qty / 1000, unit: "litre" };

  if (["pc", "pcs", "piece", "pieces", "unit", "units", "nos", "slice", "slices"].includes(u))
    return { qty, unit: "pcs" };

  // default unknown mass-like words → kg guess
  if (u.includes("cup") || u.includes("tbsp") || u.includes("tsp")) return { qty: Math.max(qty / 1000, qty * 0.001), unit: "kg" };

  return { qty, unit: "pcs" };
}

export function normalizeIngredientKey(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/** Merge duplicate dish lines (e.g. repeated Milkshake). Keeps highest price if conflict. */
export function dedupeMenuItems(items: ParsedMenuItem[]): ParsedMenuItem[] {
  const map = new Map<string, ParsedMenuItem>();
  for (const it of items) {
    const key = normalizeIngredientKey(it.name);
    if (!key) continue;
    const prev = map.get(key);
    if (!prev) {
      map.set(key, {
        name: it.name.trim(),
        category: it.category?.trim() || "General",
        price: it.price,
        type: it.type
      });
      continue;
    }
    const price = Math.max(prev.price ?? 0, it.price ?? 0);
    map.set(key, {
      name: prev.name,
      category: prev.category || it.category?.trim() || "General",
      price: price || undefined,
      type: prev.type ?? it.type
    });
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function normalizeParsedIngredient(ai: AiRecipeIngredient): AiRecipeIngredient {
  return {
    name: ai.name.trim(),
    qty: Math.max(0, Number(ai.qty) || 0),
    unit: String(ai.unit || "pcs").trim() || "pcs"
  };
}
