import fs from "fs";
import path from "path";
import type { Order } from "../types/order";
import { DATA_DIR } from "../paths";
import { writeJsonValueAtomicSync } from "../storage/jsonPersistence";
import { LEGACY_DEFAULT_STORE_ID } from "../tenant/posStoreRegistry";

export type BillLine = { name: string; qty: number; unitPrice: number; lineTotal: number };

export type GuestBillRecord = {
  id: string;
  orderId: string;
  storeId: string;
  createdAt: string;
  cafeName: string;
  table: string;
  customerName?: string;
  customerPhone?: string;
  items: BillLine[];
  subtotal: number;
  gst_rate: number;
  gst_amount: number;
  final_total: number;
  payment_status: string;
};

const BILLS_FILE = path.join(DATA_DIR, "guest-bills.json");
const GST_RATE = 0.05;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function loadAll(): GuestBillRecord[] {
  try {
    const data = fs.readFileSync(BILLS_FILE, "utf-8");
    const arr = JSON.parse(data) as unknown;
    return Array.isArray(arr) ? (arr as GuestBillRecord[]) : [];
  } catch {
    return [];
  }
}

function saveAll(list: GuestBillRecord[]) {
  setImmediate(() => {
    try {
      fs.mkdirSync(path.dirname(BILLS_FILE), { recursive: true });
      writeJsonValueAtomicSync(BILLS_FILE, list);
    } catch (e) {
      console.error("[bills] save failed:", e);
    }
  });
}

function nextBillId(existing: GuestBillRecord[]): string {
  const max = existing.reduce((m, b) => {
    const n = parseInt(String(b.id).replace(/\D/g, ""), 10) || 0;
    return Math.max(m, n);
  }, 0);
  return `B${max + 1}`;
}

export function listBillsForStore(storeId: string, limit = 200): GuestBillRecord[] {
  const sid = storeId || LEGACY_DEFAULT_STORE_ID;
  return loadAll()
    .filter((b) => !b.storeId || b.storeId === sid)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, limit);
}

export function getBillById(id: string, storeId: string): GuestBillRecord | undefined {
  const sid = storeId || LEGACY_DEFAULT_STORE_ID;
  const b = loadAll().find((x) => x.id === id);
  if (!b) return undefined;
  if (b.storeId && b.storeId !== sid) return undefined;
  return b;
}

export function billExistsForOrder(orderId: string): boolean {
  return loadAll().some((b) => b.orderId === orderId);
}

export function createBillFromOrder(order: Order, cafeName: string, tableLabel: string): GuestBillRecord | null {
  if (billExistsForOrder(order.id)) return null;
  const subtotal = order.items.reduce((s, it) => s + it.price * it.qty, 0);
  const subR = round2(subtotal);
  const gst_amount = round2(subR * GST_RATE);
  const final_total = round2(subR + gst_amount);
  const items: BillLine[] = order.items.map((it) => ({
    name: it.name,
    qty: it.qty,
    unitPrice: it.price,
    lineTotal: round2(it.price * it.qty)
  }));
  const all = loadAll();
  const rec: GuestBillRecord = {
    id: nextBillId(all),
    orderId: order.id,
    storeId: order.storeId || LEGACY_DEFAULT_STORE_ID,
    createdAt: new Date().toISOString(),
    cafeName,
    table: tableLabel,
    customerName: order.customerName,
    customerPhone: order.customerMobile,
    items,
    subtotal: subR,
    gst_rate: GST_RATE,
    gst_amount,
    final_total,
    payment_status: order.isPaid ? "paid" : order.guestPaymentStatus === "PAID" ? "upi_verified" : "unpaid"
  };
  all.push(rec);
  saveAll(all);
  return rec;
}
