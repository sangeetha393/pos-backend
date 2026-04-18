/**
 * One-shot migration: backend/data/*.json → PostgreSQL normalized tables.
 * Run: npm run db:migrate-json (from backend folder).
 */
import dotenv from "dotenv";
import fs from "fs";
import path from "path";

dotenv.config({ path: path.join(__dirname, "..", ".env") });

import { Pool } from "pg";
import { ensureCoreSchema } from "../src/ops/schema";
import { BACKEND_ROOT } from "../src/paths";

const DATA_DIR = path.join(BACKEND_ROOT, "data");

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) {
    console.error("Set DATABASE_URL in backend/.env");
    process.exit(1);
  }

  const pool = new Pool({ connectionString });
  await ensureCoreSchema(pool);

  type JsonIng = {
    id?: string;
    name?: string;
    unit?: string;
    stock_quantity?: number;
    low_stock_threshold?: number;
    costPerUnit?: number;
  };

  const ingPath = path.join(DATA_DIR, "ingredients.json");
  if (fs.existsSync(ingPath)) {
    const raw = JSON.parse(fs.readFileSync(ingPath, "utf-8")) as JsonIng[];
    for (const row of Array.isArray(raw) ? raw : []) {
      if (!row?.name || !row.id) continue;
      await pool.query(
        `INSERT INTO pos_ingredients (legacy_key, name, unit, stock_quantity, low_stock_threshold, cost_per_unit)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (legacy_key) DO UPDATE SET
           name = EXCLUDED.name,
           unit = EXCLUDED.unit,
           stock_quantity = EXCLUDED.stock_quantity,
           low_stock_threshold = EXCLUDED.low_stock_threshold,
           cost_per_unit = EXCLUDED.cost_per_unit`,
        [
          String(row.id),
          String(row.name),
          String(row.unit ?? "kg"),
          Number(row.stock_quantity) || 0,
          Number(row.low_stock_threshold) || 0,
          row.costPerUnit != null ? Number(row.costPerUnit) : null
        ]
      );
    }
    console.log("[migrate] ingredients processed");
  }

  type JsonRecipe = { productId?: string; ingredientId?: string; qty?: number };
  const recPath = path.join(DATA_DIR, "recipes.json");
  if (fs.existsSync(recPath)) {
    const raw = JSON.parse(fs.readFileSync(recPath, "utf-8")) as JsonRecipe[];
    for (const row of Array.isArray(raw) ? raw : []) {
      const pid = String(row.productId ?? "").trim();
      const iid = String(row.ingredientId ?? "").trim();
      const qty = Number(row.qty);
      if (!pid || !iid || !Number.isFinite(qty)) continue;
      const ingUuid = await pool.query(`SELECT id FROM pos_ingredients WHERE legacy_key = $1`, [iid]);
      const uuid = ingUuid.rows[0]?.id as string | undefined;
      if (!uuid) continue;
      await pool.query(
        `INSERT INTO pos_recipes (product_id, ingredient_id, quantity_used)
         VALUES ($1, $2, $3)
         ON CONFLICT (product_id, ingredient_id) DO UPDATE SET quantity_used = EXCLUDED.quantity_used`,
        [pid, uuid, qty]
      );
    }
    console.log("[migrate] recipes processed");
  }

  type JsonProduct = { id?: string; name?: string; price?: number; category?: string };
  const prodPath = path.join(DATA_DIR, "products.json");
  if (fs.existsSync(prodPath)) {
    const raw = JSON.parse(fs.readFileSync(prodPath, "utf-8")) as JsonProduct[];
    for (const row of Array.isArray(raw) ? raw : []) {
      if (!row?.id || !row?.name) continue;
      await pool.query(
        `INSERT INTO pos_menu_products (id, name, price, category)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, price = EXCLUDED.price, category = EXCLUDED.category`,
        [String(row.id), String(row.name), Number(row.price) || 0, row.category ?? null]
      );
    }
    console.log("[migrate] menu products processed");
  }

  await pool.end();
  console.log("[migrate] done");
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
