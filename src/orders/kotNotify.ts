type EmitFn = (event: string, payload?: unknown) => void;

let emitKot: EmitFn | null = null;

export function setKotSocketEmitter(fn: EmitFn | null): void {
  emitKot = fn;
}

/** Payload for chef display (`new-order` Socket.IO event). */
export type KotNewOrderPayload = {
  billNo: string;
  tableNo: string;
  items: Array<{ name: string; quantity: number }>;
  timestamp: string;
  orderId?: string;
  merged?: boolean;
};

export function emitNewOrderKot(payload: KotNewOrderPayload): void {
  try {
    emitKot?.("new-order", { at: Date.now(), ...payload });
  } catch (e) {
    console.error("new-order emit failed", e);
  }
}

/** Kitchen / KOT board — line items, status, and ticket list changes. */
export function notifyKotUpdated(payload?: Record<string, unknown>): void {
  const base = { at: Date.now(), ...payload };
  try {
    emitKot?.("kot_updated", base);
    emitKot?.("order_updated", base);
  } catch (e) {
    console.error("kot emit failed", e);
  }
}

/** New POS / QR order row inserted (not used for merge-into-existing). */
export function notifyOrderCreated(payload: Record<string, unknown>): void {
  try {
    emitKot?.("order_created", { at: Date.now(), ...payload });
  } catch (e) {
    console.error("order_created emit failed", e);
  }
}

/** KOT / billing / service toasts — payload is usually a {@link PosNotificationRecord}. */
export function emitPosNotification(payload: unknown): void {
  try {
    emitKot?.("pos_notification", payload);
  } catch (e) {
    console.error("pos_notification emit failed", e);
  }
}
