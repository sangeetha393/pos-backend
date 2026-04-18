import type { Order, OrderItem } from "../types/order";
import { isPostgresLive, getPool } from "../db/pool";

function itemsToJsonb(items: OrderItem[]): unknown[] {
  return items.map((it) => ({
    id: it.id,
    name: it.name,
    price: it.price,
    qty: it.qty,
    kotLineId: it.kotLineId,
    lineStatus: it.lineStatus
  }));
}

/**
 * Persist paid sale + sale transaction + ingredient deductions when PostgreSQL is enabled.
 * Safe to call from payment handlers; logs and skips if DB unavailable.
 */
export async function recordPosSaleToPostgres(
  order: Order,
  paymentMethod: string,
  amount: number
): Promise<void> {
  if (!isPostgresLive()) return;

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const itemsJson = JSON.stringify(itemsToJsonb(order.items));
    const orderInsert = await client.query<{ id: string }>(
      `INSERT INTO pos_orders (legacy_order_id, items, total_amount, payment_method)
       VALUES ($1, $2::jsonb, $3, $4)
       RETURNING id`,
      [order.id, itemsJson, amount, paymentMethod ?? null]
    );
    const sqlOrderId = orderInsert.rows[0]?.id;

    await client.query(
      `INSERT INTO pos_transactions (type, amount, payment_method, note, related_order_id)
       VALUES ('sale', $1, $2, $3, $4)`,
      [amount, paymentMethod ?? null, `Order ${order.id}`, sqlOrderId ?? null]
    );

    await client.query(
      `WITH lines AS (
         SELECT (elem->>'id') AS product_id, COALESCE((elem->>'qty')::numeric, 1) AS qty
         FROM jsonb_array_elements($1::jsonb) elem
       ),
       needs AS (
         SELECT r.ingredient_id, SUM(r.quantity_used * lines.qty) AS need
         FROM lines
         JOIN pos_recipes r ON r.product_id = lines.product_id
         GROUP BY r.ingredient_id
       )
       UPDATE pos_ingredients i
       SET stock_quantity = GREATEST(0, i.stock_quantity - needs.need)
       FROM needs
       WHERE i.id = needs.ingredient_id`,
      [itemsJson]
    );

    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
