import fs from "fs";
import path from "path";
import initSqlJs from "sql.js";
import { DATA_DIR } from "../paths";

const DB_FILE = path.join(DATA_DIR, "cafe_orders.sqlite");

let db: import("sql.js").Database | null = null;

/**
 * File-backed SQLite (sql.js WASM) — mirrors runtime orders for durable backup.
 */
export async function initSqliteOrderBackup(): Promise<void> {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const SQL = await initSqlJs();
    if (fs.existsSync(DB_FILE)) {
      const buf = fs.readFileSync(DB_FILE);
      db = new SQL.Database(buf);
    } else {
      db = new SQL.Database();
    }
    db!.run(
      `CREATE TABLE IF NOT EXISTS orders_snapshot (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL, updated_at INTEGER NOT NULL);`
    );
    flushDbToDisk();
    console.log("[sqlite] Order backup DB ready at", DB_FILE);
  } catch (e) {
    console.error("[sqlite] Order backup init failed (optional):", e);
    db = null;
  }
}

function flushDbToDisk(): void {
  if (!db) return;
  try {
    const data = db.export();
    fs.writeFileSync(DB_FILE, Buffer.from(data));
  } catch (e) {
    console.error("[sqlite] flush failed:", e);
  }
}

export function writeOrdersSnapshotJson(json: string): void {
  if (!db) return;
  try {
    db.run("INSERT OR REPLACE INTO orders_snapshot (id, json, updated_at) VALUES (1, ?, ?)", [json, Date.now()]);
    flushDbToDisk();
  } catch (e) {
    console.error("[sqlite] Order backup write failed:", e);
  }
}
