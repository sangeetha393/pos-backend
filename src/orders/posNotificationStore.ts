/**
 * In-memory ring buffer of POS / KOT events for staff + customer-facing pages.
 * Suitable for single-node; replace with Redis + DB for horizontal scale.
 */

export type PosNotificationAudience = "kitchen" | "service" | "billing" | "customer" | "all_staff";

export type PosNotificationRecord = {
  id: string;
  at: number;
  kind: string;
  title: string;
  body: string;
  audiences: PosNotificationAudience[];
  orderId?: string;
  tableId?: string;
};

const MAX = 120;
const items: PosNotificationRecord[] = [];

export function pushPosNotification(
  rec: Omit<PosNotificationRecord, "id" | "at"> & { id?: string }
): PosNotificationRecord {
  const id = rec.id ?? `N${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const row: PosNotificationRecord = { ...rec, id, at: Date.now() };
  items.push(row);
  while (items.length > MAX) items.shift();
  return row;
}

export function listPosNotifications(limit = 100): PosNotificationRecord[] {
  if (limit <= 0) return [];
  return items.slice(-limit).reverse();
}
