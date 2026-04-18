import { Router, type Request, type Response } from "express";
import type { Order, OrderStatus } from "../types/order";
import { orders, nextOrderId, touchOrders } from "../orders/orderStore";
import { normalizeItem, newLineId } from "../orders/orderNormalize";
import { notifyOrderCreated, emitNewOrderKot } from "../orders/kotNotify";

type KotStatus = "pending" | "preparing" | "done";

type KotCreateBody = {
  tableId?: string;
  items?: Array<{
    id?: string;
    name?: string;
    qty?: number;
    price?: number;
    specialInstructions?: string;
    modifiers?: string[];
  }>;
  clientRequestId?: string;
};

function posToKotStatus(status: OrderStatus): KotStatus {
  if (status === "new") return "pending";
  if (status === "cooking" || status === "ready") return "preparing";
  return "done";
}

function kotToPosStatus(status: KotStatus): OrderStatus {
  if (status === "pending") return "new";
  if (status === "preparing") return "cooking";
  return "completed";
}

function tableNoForKot(order: Order): string {
  if (order.tableId === "DELIVERY") return "Delivery";
  if (order.tableId === "TAKEAWAY") return "Takeaway";
  return order.tableId;
}

function mapOrderToKotDto(order: Order) {
  return {
    id: order.id,
    tableId: order.tableId,
    status: posToKotStatus(order.status),
    createdAt: order.createdAt,
    time: order.createdAt,
    items: order.items.map((it) => ({
      id: it.id,
      kotLineId: it.kotLineId,
      name: it.name,
      qty: it.qty,
      lineStatus: it.lineStatus
    }))
  };
}

function isOrderActiveForKot(order: Order): boolean {
  return !order.isPaid && order.status !== "cancelled" && order.status !== "completed";
}

export function createKotRouter(): Router {
  const router = Router();

  router.get("/orders", (_req: Request, res: Response) => {
    const list = orders
      .filter(isOrderActiveForKot)
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
      .map(mapOrderToKotDto);
    res.json(list);
  });

  router.post("/orders", (req: Request, res: Response) => {
    const body = (req.body ?? {}) as KotCreateBody;
    const tableId = (body.tableId || "").trim();
    const rid = (body.clientRequestId || "").trim();
    const rawItems = Array.isArray(body.items) ? body.items : [];

    if (!tableId) return res.status(400).json({ error: "tableId is required" });
    if (!rawItems.length) return res.status(400).json({ error: "items are required" });

    if (rid) {
      const dup = orders.find((o) => o.lastClientRequestId === rid);
      if (dup) {
        return res.status(200).json({ ...mapOrderToKotDto(dup), duplicate: true });
      }
    }

    const items = rawItems
      .map((row) => {
        const id = String(row.id || "").trim();
        const name = String(row.name || "Item").trim();
        const qty = Math.max(1, Math.floor(Number(row.qty) || 1));
        const price = Math.max(0, Number(row.price) || 0);
        if (!id) return null;
        return normalizeItem({
          id,
          name: name || "Item",
          qty,
          price,
          specialInstructions: typeof row.specialInstructions === "string" ? row.specialInstructions : undefined,
          modifiers: Array.isArray(row.modifiers) ? row.modifiers : undefined,
          kotLineId: newLineId(),
          lineStatus: "new"
        });
      })
      .filter((x): x is NonNullable<typeof x> => x != null);

    if (!items.length) {
      return res.status(400).json({ error: "each item must include a valid id" });
    }

    const now = new Date().toISOString();
    const order: Order = {
      id: nextOrderId(),
      tableId,
      items,
      status: "new",
      createdAt: now,
      isPaid: false,
      ...(rid ? { lastClientRequestId: rid, lastClientRequestAt: now } : {})
    };

    orders.push(order);
    notifyOrderCreated({ orderId: order.id, tableId: order.tableId, source: "pos_kot" });
    emitNewOrderKot({
      billNo: order.id,
      tableNo: tableNoForKot(order),
      items: order.items.map((i) => ({ name: i.name, quantity: i.qty })),
      timestamp: order.createdAt,
      orderId: order.id,
      merged: false
    });
    touchOrders("kot_order_create");

    return res.status(201).json(mapOrderToKotDto(order));
  });

  router.patch("/orders/:id/status", (req: Request, res: Response) => {
    const id = (req.params.id || "").trim();
    const statusIn = String((req.body as { status?: string })?.status || "").trim().toLowerCase();
    const status = statusIn as KotStatus;

    if (!id) return res.status(400).json({ error: "id is required" });
    if (status !== "pending" && status !== "preparing" && status !== "done") {
      return res.status(400).json({ error: "status must be pending, preparing, or done" });
    }

    const order = orders.find((o) => o.id === id);
    if (!order) return res.status(404).json({ error: "Order not found" });

    const current = posToKotStatus(order.status);
    const allowedTransitions: Record<KotStatus, KotStatus[]> = {
      pending: ["preparing"],
      preparing: ["done"],
      done: []
    };
    if (!allowedTransitions[current].includes(status)) {
      return res.status(400).json({ error: `Invalid status transition: ${current} -> ${status}` });
    }

    const now = new Date().toISOString();
    const nextPosStatus = kotToPosStatus(status);
    order.status = nextPosStatus;
    if (nextPosStatus === "cooking") order.cookingAt = order.cookingAt || now;
    if (nextPosStatus === "completed") order.servedAt = order.servedAt || now;

    touchOrders("kot_order_status");
    return res.json(mapOrderToKotDto(order));
  });

  return router;
}
