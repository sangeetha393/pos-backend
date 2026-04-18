import fs from "fs";
import path from "path";
import type { Order } from "../types/order";
import { normalizeOrder } from "./orderNormalize";
import { notifyKotUpdated } from "./kotNotify";
import {
  initPostgresSchema,
  loadCollectionBodies,
  replaceCollectionBodies
} from "../db/postgresCollections";
import { isPostgresLive } from "../db/pool";
import { DATA_DIR } from "../paths";
import { LEGACY_DEFAULT_STORE_ID } from "../tenant/posStoreRegistry";
import { enqueueJsonWrite, readJsonArrayFileOrEmpty } from "../storage/jsonPersistence";
import { writeOrdersSnapshotJson } from "../db/sqljsOrderBackup";

const ORDERS_FILE = path.join(DATA_DIR, "orders.json");

function normalizeOrderStoreIds(list: Order[]): boolean {
  let changed = false;
  for (const o of list) {
    if (!o.storeId) {
      (o as Order).storeId = LEGACY_DEFAULT_STORE_ID;
      changed = true;
    }
  }
  return changed;
}

export function ordersForStore(storeId: string): Order[] {
  const sid = storeId || LEGACY_DEFAULT_STORE_ID;
  return orders.filter((o) => (o.storeId || LEGACY_DEFAULT_STORE_ID) === sid);
}

/** In-memory order list — single source of truth at runtime. */
export let orders: Order[] = [];

let persistTimer: ReturnType<typeof setTimeout> | null = null;
const DEBOUNCE_MS = 80;

export async function initOrderStore(): Promise<void> {
  if (isPostgresLive()) {
    try {
      await initPostgresSchema();
      const bodies = await loadCollectionBodies("orders");
      orders = bodies.map((row) => normalizeOrder(row as Record<string, unknown>));
      if (normalizeOrderStoreIds(orders)) {
        await persistOrdersToStorage();
      }
      if (!orders.length) {
        await persistOrdersToStorage();
      }
      console.log(`[orders] Loaded ${orders.length} orders from PostgreSQL`);
    } catch (e) {
      console.error("[orders] PostgreSQL load failed, starting empty:", e);
      orders = [];
    }
    return;
  }

  try {
    await fs.promises.mkdir(DATA_DIR, { recursive: true });
  } catch (e) {
    console.error("[orders] mkdir data:", e);
  }
  try {
    if (!fs.existsSync(ORDERS_FILE)) {
      orders = [];
      await persistOrdersToStorage();
      console.log(`[orders] Created empty ${ORDERS_FILE}`);
    } else {
      const parsed = readJsonArrayFileOrEmpty(DATA_DIR, ORDERS_FILE);
      orders = parsed.map((row) => normalizeOrder(row as Record<string, unknown>));
      if (normalizeOrderStoreIds(orders)) {
        void persistOrdersToStorage();
      }
      console.log(`[orders] Loaded ${orders.length} orders from ${ORDERS_FILE}`);
    }
  } catch (e) {
    console.error("[orders] Load failed, starting empty:", e);
    orders = [];
  }
}

export async function persistOrdersToStorage(): Promise<void> {
  if (isPostgresLive()) {
    try {
      await replaceCollectionBodies(
        "orders",
        orders.map((o) => ({ docId: o.id, body: o as unknown as Record<string, unknown> }))
      );
      try {
        writeOrdersSnapshotJson(JSON.stringify(orders));
      } catch {
        /* sqlite mirror optional */
      }
    } catch (e) {
      console.error("[orders] PostgreSQL persist failed:", e);
    }
    return;
  }
  try {
    await fs.promises.mkdir(DATA_DIR, { recursive: true });
    await enqueueJsonWrite(ORDERS_FILE, orders, true);
    try {
      writeOrdersSnapshotJson(JSON.stringify(orders));
    } catch {
      /* sqlite mirror optional */
    }
  } catch (e) {
    console.error("[orders] File persist failed:", e);
  }
}

export function schedulePersistOrders(): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void persistOrdersToStorage();
  }, DEBOUNCE_MS);
}

/** Call after any mutation to orders[]. */
export function touchOrders(kotReason?: string): void {
  schedulePersistOrders();
  notifyKotUpdated(kotReason ? { reason: kotReason } : undefined);
}

/** Persist orders without notifying kitchen sockets (e.g. guest UPI ticket not yet verified). */
export function persistOrdersOnly(): void {
  schedulePersistOrders();
}

/** @deprecated Use persistOrdersToStorage */
export async function flushOrdersToDisk(): Promise<void> {
  await persistOrdersToStorage();
}

export function nextOrderId(): string {
  const max = orders.reduce((m, o) => {
    const n = parseInt(String(o.id).replace(/\D/g, ""), 10) || 0;
    return Math.max(m, n);
  }, 0);
  return `O${max + 1}`;
}
