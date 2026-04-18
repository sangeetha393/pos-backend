/** Kitchen line status per item */
export type OrderItemLineStatus = "new" | "cooking" | "ready";

/** Order lifecycle (strict flow; cancelled anytime from non-terminal) */
export type OrderStatus = "new" | "cooking" | "ready" | "served" | "completed" | "cancelled";

/** Guest QR payment — kitchen board only shows PAY_AT_COUNTER and PAID (and legacy rows without this field). */
export type GuestPaymentStatus =
  | "PAY_AT_COUNTER"
  | "UPI_PENDING"
  | "PAYMENT_PENDING_VERIFICATION"
  | "PAYMENT_FAILED"
  | "PAID";

export type OrderItem = {
  id: string;
  name: string;
  price: number;
  qty: number;
  category?: string;
  type?: "veg" | "non_veg" | "egg";
  sku?: string;
  imageUrl?: string;
  modifiers?: string[];
  specialInstructions?: string;
  /** Stable id for PATCH item status */
  kotLineId: string;
  lineStatus: OrderItemLineStatus;
  /** True when merged into an existing open order on this table */
  isNewlyAdded?: boolean;
};

export type Order = {
  id: string;
  /** Hotel / tenant (admin user id). Missing on legacy rows = migrated default store. */
  storeId?: string;
  tableId: string;
  items: OrderItem[];
  status: OrderStatus;
  createdAt: string;
  isPaid: boolean;
  customerName?: string;
  customerMobile?: string;
  customerAddress?: string;
  customerLocality?: string;
  /** Staff serving this ticket (set from POS); name denormalized for exports. */
  waiterId?: string;
  waiterName?: string;
  cookingAt?: string;
  readyAt?: string;
  servedAt?: string;
  /** Set when items were merged into an existing ticket */
  isUpdated?: boolean;
  /** Dedup: optional client id for POST /orders */
  lastClientRequestId?: string;
  lastClientRequestAt?: string;
  /** Set for guest QR flows; omit on legacy POS orders. */
  guestPaymentStatus?: GuestPaymentStatus;
  /** Manual bill discount in currency (applied at billing; capped at items subtotal). */
  billDiscount?: number;
};

/** KOT / table views: hide tickets until UPI is verified by staff. */
export function orderVisibleOnKitchenBoard(o: Order): boolean {
  const g = o.guestPaymentStatus;
  if (g === undefined || g === null) return true;
  return g === "PAY_AT_COUNTER" || g === "PAID";
}

export const ORDER_STATUS_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  new: ["cooking", "cancelled"],
  cooking: ["ready", "cancelled"],
  ready: ["served", "cancelled"],
  served: ["completed", "cancelled"],
  completed: [],
  cancelled: []
};

export function canTransitionOrderStatus(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_STATUS_TRANSITIONS[from]?.includes(to) ?? false;
}

export const LINE_STATUS_TRANSITIONS: Record<OrderItemLineStatus, OrderItemLineStatus[]> = {
  new: ["cooking"],
  cooking: ["ready"],
  ready: []
};

export function canTransitionLineStatus(from: OrderItemLineStatus, to: OrderItemLineStatus): boolean {
  return LINE_STATUS_TRANSITIONS[from]?.includes(to) ?? false;
}
