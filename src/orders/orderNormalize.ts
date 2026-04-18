import { randomUUID } from "crypto";
import type {
  Order,
  OrderItem,
  OrderItemLineStatus,
  OrderStatus,
  GuestPaymentStatus
} from "../types/order";

function newLineId(): string {
  return `L${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

export function normalizeItem(raw: Partial<OrderItem> & { id: string; name: string; price: number; qty: number }): OrderItem {
  const lineStatus: OrderItemLineStatus =
    raw.lineStatus === "cooking" || raw.lineStatus === "ready" ? raw.lineStatus : "new";
  return {
    id: raw.id,
    name: raw.name,
    price: raw.price,
    qty: raw.qty,
    category: raw.category,
    type: raw.type,
    sku: raw.sku,
    imageUrl: raw.imageUrl,
    modifiers: raw.modifiers,
    specialInstructions: raw.specialInstructions,
    kotLineId: raw.kotLineId || newLineId(),
    lineStatus,
    isNewlyAdded: raw.isNewlyAdded
  };
}

export function normalizeOrder(raw: Record<string, unknown>): Order {
  const itemsIn = Array.isArray(raw.items) ? (raw.items as Record<string, unknown>[]) : [];
  const items: OrderItem[] = itemsIn.map((row) =>
    normalizeItem({
      id: String(row.id ?? ""),
      name: String(row.name ?? "Item"),
      price: Number(row.price) || 0,
      qty: Math.max(1, Math.floor(Number(row.qty) || 1)),
      category: typeof row.category === "string" ? row.category : undefined,
      type: row.type === "veg" || row.type === "non_veg" || row.type === "egg" ? row.type : undefined,
      sku: typeof row.sku === "string" ? row.sku : undefined,
      imageUrl: typeof row.imageUrl === "string" ? row.imageUrl : undefined,
      modifiers: Array.isArray(row.modifiers) ? (row.modifiers as string[]) : undefined,
      specialInstructions: typeof row.specialInstructions === "string" ? row.specialInstructions : undefined,
      kotLineId: typeof row.kotLineId === "string" ? row.kotLineId : undefined,
      lineStatus:
        row.lineStatus === "cooking" || row.lineStatus === "ready" || row.lineStatus === "new"
          ? row.lineStatus
          : undefined,
      isNewlyAdded: row.isNewlyAdded === true
    })
  );

  let status = String(raw.status || "new") as OrderStatus;
  const allowed: OrderStatus[] = ["new", "cooking", "ready", "served", "completed", "cancelled"];
  if (!allowed.includes(status)) status = "new";

  const guestPayRaw = raw.guestPaymentStatus;
  const guestPaymentAllowed: GuestPaymentStatus[] = [
    "PAY_AT_COUNTER",
    "UPI_PENDING",
    "PAYMENT_PENDING_VERIFICATION",
    "PAYMENT_FAILED",
    "PAID"
  ];
  const guestPaymentStatus =
    typeof guestPayRaw === "string" && guestPaymentAllowed.includes(guestPayRaw as GuestPaymentStatus)
      ? (guestPayRaw as GuestPaymentStatus)
      : undefined;

  return {
    id: String(raw.id ?? ""),
    storeId: typeof raw.storeId === "string" && raw.storeId.trim() ? raw.storeId.trim() : undefined,
    tableId: String(raw.tableId ?? ""),
    items,
    status,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString(),
    isPaid: raw.isPaid === true,
    customerName: typeof raw.customerName === "string" ? raw.customerName : undefined,
    customerMobile: typeof raw.customerMobile === "string" ? raw.customerMobile : undefined,
    customerAddress: typeof raw.customerAddress === "string" ? raw.customerAddress : undefined,
    customerLocality: typeof raw.customerLocality === "string" ? raw.customerLocality : undefined,
    waiterId: typeof raw.waiterId === "string" ? raw.waiterId : undefined,
    waiterName: typeof raw.waiterName === "string" ? raw.waiterName : undefined,
    cookingAt: typeof raw.cookingAt === "string" ? raw.cookingAt : undefined,
    readyAt: typeof raw.readyAt === "string" ? raw.readyAt : undefined,
    servedAt: typeof raw.servedAt === "string" ? raw.servedAt : undefined,
    isUpdated: raw.isUpdated === true,
    lastClientRequestId: typeof raw.lastClientRequestId === "string" ? raw.lastClientRequestId : undefined,
    lastClientRequestAt: typeof raw.lastClientRequestAt === "string" ? raw.lastClientRequestAt : undefined,
    guestPaymentStatus
  };
}

export function itemMergeKey(item: Pick<OrderItem, "id" | "modifiers" | "specialInstructions">): string {
  const mods = [...(item.modifiers ?? [])].sort().join("\u0001");
  const note = (item.specialInstructions ?? "").trim();
  return `${item.id}\u0001${mods}\u0001${note}`;
}

export { newLineId };
