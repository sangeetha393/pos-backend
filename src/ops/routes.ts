import { Express, Router, Request, Response, NextFunction } from "express";
import { authMiddleware } from "../middleware/auth.middleware";
import { isPostgresConfigured, isPostgresLive, getPool, lastPostgresInitError } from "../db/pool";

function requirePg(_req: Request, res: Response, next: NextFunction): void {
  if (!isPostgresLive()) {
    res.status(503).json({ error: "Set DATABASE_URL to enable PostgreSQL Ops API." });
    return;
  }
  next();
}

function dayBounds(d: Date): { start: Date; end: Date } {
  const start = new Date(d);
  start.setHours(0, 0, 0, 0);
  const end = new Date(d);
  end.setHours(23, 59, 59, 999);
  return { start, end };
}

export function registerOpsRoutes(app: Express): void {
  const api = Router();

  api.get("/status", (_req: Request, res: Response) => {
    res.json({
      ok: true,
      postgres: isPostgresLive(),
      configured: isPostgresConfigured(),
      lastError: isPostgresConfigured() && !isPostgresLive() ? lastPostgresInitError : null
    });
  });

  const prot = Router();
  prot.use(requirePg);
  prot.use(authMiddleware);

  prot.get("/dashboard", async (req: Request, res: Response) => {
    const pool = getPool();
    const tzDay = (req.query.date as string) || new Date().toISOString().slice(0, 10);
    const d = new Date(tzDay + "T12:00:00");
    const { start, end } = dayBounds(d);

    const sales = await pool.query<{ c: string; s: string }>(
      `SELECT COUNT(*)::text c, COALESCE(SUM(amount),0)::text s FROM pos_transactions
       WHERE type = 'sale' AND created_at >= $1 AND created_at <= $2`,
      [start, end]
    );
    const expenses = await pool.query<{ c: string; s: string }>(
      `SELECT COUNT(*)::text c, COALESCE(SUM(amount),0)::text s FROM pos_transactions
       WHERE type = 'expense' AND created_at >= $1 AND created_at <= $2`,
      [start, end]
    );
    const low = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text FROM pos_ingredients WHERE stock_quantity <= low_stock_threshold`
    );

    const saleTotal = Number(sales.rows[0]?.s ?? 0);
    const expenseTotal = Number(expenses.rows[0]?.s ?? 0);

    res.json({
      date: tzDay,
      salesTotal: saleTotal,
      salesCount: Number(sales.rows[0]?.c ?? 0),
      expensesTotal: expenseTotal,
      expensesCount: Number(expenses.rows[0]?.c ?? 0),
      net: Math.round((saleTotal - expenseTotal) * 100) / 100,
      lowStockCount: Number(low.rows[0]?.count ?? 0)
    });
  });

  prot.get("/insights", async (req: Request, res: Response) => {
    const pool = getPool();
    const alerts: string[] = [];
    const stock: { name: string; message: string }[] = [];

    const low = await pool.query(
      `SELECT name, stock_quantity, low_stock_threshold, unit FROM pos_ingredients
       WHERE stock_quantity <= low_stock_threshold ORDER BY stock_quantity ASC LIMIT 20`
    );
    for (const row of low.rows) {
      alerts.push(`Low stock: ${row.name}`);
    }

    const usage = await pool.query(
      `WITH days AS (
         SELECT i.id, i.name, i.stock_quantity,
                COALESCE(SUM(li.u), 0) AS used_7d
         FROM pos_ingredients i
         LEFT JOIN (
           SELECT r.ingredient_id, SUM(r.quantity_used * sub.q) u
           FROM (
             SELECT (e->>'id') pid, COALESCE((e->>'qty')::numeric, 1) q
             FROM pos_orders o, jsonb_array_elements(o.items) e
             WHERE o.created_at >= NOW() - INTERVAL '7 days'
           ) sub
           JOIN pos_recipes r ON r.product_id = sub.pid
           GROUP BY r.ingredient_id
         ) li ON li.ingredient_id = i.id
         GROUP BY i.id, i.name, i.stock_quantity
       )
       SELECT name, stock_quantity, used_7d,
        CASE WHEN used_7d > 0 THEN stock_quantity / (used_7d / 7.0) ELSE NULL END AS days_left
       FROM days
       WHERE used_7d > 0 AND stock_quantity > 0
       ORDER BY days_left ASC NULLS LAST
       LIMIT 15`
    );
    for (const row of usage.rows) {
      const dl = row.days_left != null ? Math.floor(Number(row.days_left)) : null;
      if (dl != null && dl <= 3) {
        stock.push({
          name: row.name,
          message: `${row.name} may run out in ~${dl} day(s) at recent usage.`
        });
      }
    }

    const cmp = await pool.query(
      `WITH t AS (
         SELECT COALESCE(SUM(amount),0) a FROM pos_transactions
         WHERE type='sale' AND created_at::date = CURRENT_DATE
       ), y AS (
         SELECT COALESCE(SUM(amount),0) a FROM pos_transactions
         WHERE type='sale' AND created_at::date = CURRENT_DATE - 1
       )
       SELECT t.a::float8 today, y.a::float8 yesterday FROM t,y`
    );
    const today = Number(cmp.rows[0]?.today ?? 0);
    const yesterday = Number(cmp.rows[0]?.yesterday ?? 0);
    let salesInsight = "No comparison yet.";
    if (yesterday > 0) {
      const pct = Math.round(((today - yesterday) / yesterday) * 1000) / 10;
      salesInsight = `Today vs yesterday: ${pct >= 0 ? "+" : ""}${pct}%`;
    } else if (today > 0) {
      salesInsight = "Sales today with no sales yesterday.";
    }

    if (today === 0 && yesterday === 0) alerts.push("No recorded sales today or yesterday.");

    res.json({ alerts, stockPrediction: stock, salesInsight });
  });

  prot.get("/ingredients", async (_req: Request, res: Response) => {
    const r = await getPool().query(
      `SELECT id, legacy_key, name, stock_quantity, unit, low_stock_threshold, cost_per_unit, created_at
       FROM pos_ingredients ORDER BY name`
    );
    res.json(r.rows);
  });

  prot.post("/ingredients", async (req: Request, res: Response) => {
    const { name, unit, stock_quantity, low_stock_threshold, cost_per_unit, legacy_key } = req.body as Record<
      string,
      unknown
    >;
    if (!name || typeof name !== "string") return res.status(400).json({ error: "name required" });
    const r = await getPool().query(
      `INSERT INTO pos_ingredients (name, unit, stock_quantity, low_stock_threshold, cost_per_unit, legacy_key)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        name.trim(),
        typeof unit === "string" ? unit : "kg",
        Number(stock_quantity) || 0,
        Number(low_stock_threshold) || 0,
        cost_per_unit != null ? Number(cost_per_unit) : null,
        typeof legacy_key === "string" ? legacy_key : null
      ]
    );
    res.status(201).json(r.rows[0]);
  });

  prot.patch("/ingredients/:id", async (req: Request, res: Response) => {
    const { id } = req.params;
    const body = req.body as Record<string, unknown>;
    const r = await getPool().query(
      `UPDATE pos_ingredients SET
        name = COALESCE($2, name),
        unit = COALESCE($3, unit),
        stock_quantity = COALESCE($4, stock_quantity),
        low_stock_threshold = COALESCE($5, low_stock_threshold),
        cost_per_unit = COALESCE($6, cost_per_unit)
       WHERE id = $1::uuid RETURNING *`,
      [
        id,
        typeof body.name === "string" ? body.name : null,
        typeof body.unit === "string" ? body.unit : null,
        body.stock_quantity != null ? Number(body.stock_quantity) : null,
        body.low_stock_threshold != null ? Number(body.low_stock_threshold) : null,
        body.cost_per_unit != null ? Number(body.cost_per_unit) : null
      ]
    );
    if (!r.rowCount) return res.status(404).json({ error: "Not found" });
    res.json(r.rows[0]);
  });

  prot.post("/ingredients/:id/adjust", async (req: Request, res: Response) => {
    const { id } = req.params;
    const delta = Number((req.body as { delta?: number }).delta);
    if (!Number.isFinite(delta)) return res.status(400).json({ error: "delta required" });
    const r = await getPool().query(
      `UPDATE pos_ingredients SET stock_quantity = GREATEST(0, stock_quantity + $2) WHERE id = $1::uuid RETURNING *`,
      [id, delta]
    );
    if (!r.rowCount) return res.status(404).json({ error: "Not found" });
    res.json(r.rows[0]);
  });

  prot.get("/purchase-list", async (_req: Request, res: Response) => {
    const r = await getPool().query(
      `SELECT pl.*, i.name AS ingredient_name, i.unit
       FROM pos_purchase_list pl
       JOIN pos_ingredients i ON i.id = pl.ingredient_id
       WHERE pl.status = 'pending'
       ORDER BY pl.created_at DESC`
    );
    res.json(r.rows);
  });

  prot.post("/purchase-list/sync-low-stock", async (_req: Request, res: Response) => {
    const pool = getPool();
    const ing = await pool.query(
      `SELECT id, name, stock_quantity, low_stock_threshold, unit FROM pos_ingredients
       WHERE stock_quantity <= low_stock_threshold`
    );
    let added = 0;
    for (const row of ing.rows) {
      const need = Math.max(Number(row.low_stock_threshold) - Number(row.stock_quantity), 0);
      if (need <= 0) continue;
      try {
        await pool.query(
          `INSERT INTO pos_purchase_list (ingredient_id, quantity_needed, supplier_name, status)
           VALUES ($1, $2, NULL, 'pending')`,
          [row.id, need]
        );
        added++;
      } catch {
        /* unique pending — ignore */
      }
    }
    res.json({ added, checked: ing.rows.length });
  });

  prot.patch("/purchase-list/:id", async (req: Request, res: Response) => {
    const { status } = req.body as { status?: string };
    if (status !== "pending" && status !== "purchased")
      return res.status(400).json({ error: "status must be pending|purchased" });
    const r = await getPool().query(`UPDATE pos_purchase_list SET status = $2 WHERE id = $1::uuid RETURNING *`, [
      req.params.id,
      status
    ]);
    if (!r.rowCount) return res.status(404).json({ error: "Not found" });
    res.json(r.rows[0]);
  });

  prot.post("/purchases/receive", async (req: Request, res: Response) => {
    const { ingredientId, quantity, unitCost, supplierName, note } = req.body as {
      ingredientId?: string;
      quantity?: number;
      unitCost?: number;
      supplierName?: string;
      note?: string;
    };
    if (!ingredientId || !Number.isFinite(Number(quantity)) || Number(quantity) <= 0) {
      return res.status(400).json({ error: "ingredientId and positive quantity required" });
    }
    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const ing = await client.query(
        `SELECT id, name, stock_quantity, cost_per_unit FROM pos_ingredients WHERE id = $1::uuid FOR UPDATE`,
        [ingredientId]
      );
      if (!ing.rows[0]) throw new Error("Ingredient not found");
      const q = Number(quantity);
      const cost = Number(unitCost ?? ing.rows[0].cost_per_unit ?? 0) * q;
      await client.query(`UPDATE pos_ingredients SET stock_quantity = stock_quantity + $2 WHERE id = $1::uuid`, [
        ingredientId,
        q
      ]);
      await client.query(
        `INSERT INTO pos_transactions (type, amount, payment_method, note, metadata)
         VALUES ('expense', $1, 'cash', $2, $3::jsonb)`,
        [
          Math.round(cost * 100) / 100,
          note ?? `Purchase: ${ing.rows[0].name} (+${q})`,
          JSON.stringify({ ingredientId, quantity: q, supplierName: supplierName ?? null })
        ]
      );

      await client.query(
        `UPDATE pos_purchase_list SET status = 'purchased'
         WHERE ingredient_id = $1::uuid AND status = 'pending'`,
        [ingredientId]
      );

      await client.query("COMMIT");
      res.status(201).json({ ok: true, ingredient: ing.rows[0].name, quantity: q, expense: cost });
    } catch (e) {
      await client.query("ROLLBACK");
      const msg = e instanceof Error ? e.message : "Failed";
      res.status(400).json({ error: msg });
    } finally {
      client.release();
    }
  });

  prot.get("/transactions", async (req: Request, res: Response) => {
    const from = req.query.from ? new Date(String(req.query.from)) : new Date(Date.now() - 7 * 864e5);
    const to = req.query.to ? new Date(String(req.query.to)) : new Date();
    to.setHours(23, 59, 59, 999);
    const r = await getPool().query(
      `SELECT * FROM pos_transactions WHERE created_at >= $1 AND created_at <= $2 ORDER BY created_at DESC LIMIT 500`,
      [from, to]
    );
    res.json(r.rows);
  });

  prot.post("/transactions/expense", async (req: Request, res: Response) => {
    const { amount, payment_method, note } = req.body as {
      amount?: number;
      payment_method?: string;
      note?: string;
    };
    if (!Number.isFinite(Number(amount)) || Number(amount) <= 0) {
      return res.status(400).json({ error: "positive amount required" });
    }
    const r = await getPool().query(
      `INSERT INTO pos_transactions (type, amount, payment_method, note)
       VALUES ('expense', $1, $2, $3) RETURNING *`,
      [Number(amount), payment_method ?? "cash", note ?? ""]
    );
    res.status(201).json(r.rows[0]);
  });

  prot.get("/reports/sales", async (req: Request, res: Response) => {
    const from = req.query.from ? new Date(String(req.query.from)) : new Date(Date.now() - 7 * 864e5);
    const to = req.query.to ? new Date(String(req.query.to)) : new Date();
    to.setHours(23, 59, 59, 999);
    const pool = getPool();
    const sum = await pool.query(
      `SELECT COUNT(*)::int c, COALESCE(SUM(amount),0)::float8 total FROM pos_transactions
       WHERE type='sale' AND created_at >= $1 AND created_at <= $2`,
      [from, to]
    );
    const c = sum.rows[0]?.c ?? 0;
    const total = sum.rows[0]?.total ?? 0;
    res.json({
      from: from.toISOString(),
      to: to.toISOString(),
      orderCount: c,
      totalSales: total,
      averageOrderValue: c > 0 ? Math.round((total / c) * 100) / 100 : 0
    });
  });

  prot.get("/reports/top-items", async (req: Request, res: Response) => {
    const from = req.query.from ? new Date(String(req.query.from)) : new Date(Date.now() - 7 * 864e5);
    const to = req.query.to ? new Date(String(req.query.to)) : new Date();
    to.setHours(23, 59, 59, 999);
    const r = await getPool().query(
      `WITH lines AS (
         SELECT (e->>'id') pid, (e->>'name') pname, COALESCE((e->>'qty')::numeric, 1) q
         FROM pos_orders o, jsonb_array_elements(o.items) e
         WHERE o.created_at >= $1 AND o.created_at <= $2
       )
       SELECT pid, MAX(pname) name, SUM(q)::float8 qty FROM lines GROUP BY pid ORDER BY qty DESC LIMIT 5`,
      [from, to]
    );
    res.json(r.rows);
  });

  prot.get("/reports/peak-hours", async (req: Request, res: Response) => {
    const from = req.query.from ? new Date(String(req.query.from)) : new Date(Date.now() - 7 * 864e5);
    const to = req.query.to ? new Date(String(req.query.to)) : new Date();
    to.setHours(23, 59, 59, 999);
    const r = await getPool().query(
      `SELECT EXTRACT(HOUR FROM created_at)::int AS hour,
              COALESCE(SUM(amount),0)::float8 total
       FROM pos_transactions
       WHERE type='sale' AND created_at >= $1 AND created_at <= $2
       GROUP BY 1 ORDER BY 1`,
      [from, to]
    );
    const buckets = Array.from({ length: 24 }, (_, h) => ({ hour: h, total: 0 }));
    for (const row of r.rows) {
      const h = Number(row.hour);
      if (h >= 0 && h < 24) buckets[h].total = Number(row.total);
    }
    const peak = buckets.reduce((a, b) => (a.total >= b.total ? a : b), buckets[0]);
    res.json({ buckets, peakHour: peak.hour, peakTotal: peak.total });
  });

  prot.get("/reports/profit-estimate", async (req: Request, res: Response) => {
    const from = req.query.from ? new Date(String(req.query.from)) : new Date(Date.now() - 7 * 864e5);
    const to = req.query.to ? new Date(String(req.query.to)) : new Date();
    to.setHours(23, 59, 59, 999);
    const r = await getPool().query(
      `WITH lines AS (
         SELECT (e->>'id') pid, COALESCE((e->>'price')::numeric, 0) price, COALESCE((e->>'qty')::numeric, 1) q
         FROM pos_orders o, jsonb_array_elements(o.items) e
         WHERE o.created_at >= $1 AND o.created_at <= $2
       ),
       cost AS (
         SELECT l.pid, SUM(r.quantity_used * l.q * COALESCE(i.cost_per_unit, 0)) AS c
         FROM lines l
         JOIN pos_recipes r ON r.product_id = l.pid
         JOIN pos_ingredients i ON i.id = r.ingredient_id
         GROUP BY l.pid
       ),
       rev AS ( SELECT pid, SUM(price * q) r FROM lines GROUP BY pid )
       SELECT COALESCE(SUM(rev.r),0)::float8 revenue, COALESCE(SUM(cost.c),0)::float8 ingredient_cost
       FROM rev LEFT JOIN cost ON cost.pid = rev.pid`,
      [from, to]
    );
    const revenue = Number(r.rows[0]?.revenue ?? 0);
    const ing = Number(r.rows[0]?.ingredient_cost ?? 0);
    res.json({
      revenue,
      estimatedIngredientCost: ing,
      estimatedGross: Math.round((revenue - ing) * 100) / 100
    });
  });

  prot.get("/stock-ledger", async (req: Request, res: Response) => {
    const date = (req.query.date as string) || new Date().toISOString().slice(0, 10);
    const r = await getPool().query(
      `SELECT sl.*, i.name AS ingredient_name, i.unit
       FROM pos_stock_ledger sl
       JOIN pos_ingredients i ON i.id = sl.ingredient_id
       WHERE sl.ledger_date = $1::date ORDER BY i.name`,
      [date]
    );
    res.json(r.rows);
  });

  prot.post("/stock-ledger/close-day", async (req: Request, res: Response) => {
    const { date, wastage, actuals } = req.body as {
      date?: string;
      wastage?: { ingredientId: string; qty: number }[];
      actuals?: { ingredientId: string; actual: number }[];
    };
    const d = date || new Date().toISOString().slice(0, 10);
    if (!actuals || !Array.isArray(actuals)) {
      return res.status(400).json({ error: "actuals array required" });
    }
    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const wmap = new Map((wastage ?? []).map((w) => [w.ingredientId, Number(w.qty) || 0]));

      const usedRows = await client.query(
        `WITH lines AS (
           SELECT (e->>'id') pid, COALESCE((e->>'qty')::numeric, 1) q
           FROM pos_orders o, jsonb_array_elements(o.items) e
           WHERE o.created_at::date = $1::date
         ),
         needs AS (
           SELECT r.ingredient_id, SUM(r.quantity_used * lines.q) u
           FROM lines
           JOIN pos_recipes r ON r.product_id = lines.pid
           GROUP BY r.ingredient_id
         )
         SELECT * FROM needs`,
        [d]
      );
      const umap = new Map<string, number>(
        usedRows.rows.map((row: { ingredient_id: string; u: string }) => [row.ingredient_id, Number(row.u)])
      );

      for (const a of actuals) {
        const ingredientId = a.ingredientId;
        const actual = Number(a.actual);
        if (!ingredientId || !Number.isFinite(actual)) continue;

        const ing = await client.query(
          `SELECT stock_quantity FROM pos_ingredients WHERE id = $1::uuid FOR UPDATE`,
          [ingredientId]
        );
        if (!ing.rows[0]) continue;

        const prev = await client.query(
          `SELECT closing_stock, actual_stock FROM pos_stock_ledger
           WHERE ingredient_id = $1::uuid AND ledger_date = ($2::date - 1)`,
          [ingredientId, d]
        );
        const opening = prev.rows[0]
          ? Number(prev.rows[0].actual_stock ?? prev.rows[0].closing_stock)
          : Number(ing.rows[0].stock_quantity);

        const purchases = await client.query(
          `SELECT COALESCE(SUM((metadata->>'quantity')::numeric), 0) s FROM pos_transactions
           WHERE type='expense' AND created_at::date = $2::date
             AND (metadata->>'ingredientId')::text = $1`,
          [ingredientId, d]
        );
        const purchasedQty = Number(purchases.rows[0]?.s ?? 0);
        const usedQty = umap.get(ingredientId) ?? 0;
        const wastedQty = wmap.get(ingredientId) ?? 0;
        const expectedClosing = opening + purchasedQty - usedQty - wastedQty;

        await client.query(
          `INSERT INTO pos_stock_ledger (
             ingredient_id, opening_stock, purchased_qty, used_qty, wasted_qty, closing_stock, actual_stock, ledger_date)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::date)
           ON CONFLICT (ingredient_id, ledger_date) DO UPDATE SET
             opening_stock = EXCLUDED.opening_stock,
             purchased_qty = EXCLUDED.purchased_qty,
             used_qty = EXCLUDED.used_qty,
             wasted_qty = EXCLUDED.wasted_qty,
             closing_stock = EXCLUDED.closing_stock,
             actual_stock = EXCLUDED.actual_stock`,
          [ingredientId, opening, purchasedQty, usedQty, wastedQty, expectedClosing, actual, d]
        );
      }

      await client.query("COMMIT");
      res.json({ ok: true, date: d, closed: actuals.length });
    } catch (e) {
      await client.query("ROLLBACK");
      res.status(400).json({ error: e instanceof Error ? e.message : "close failed" });
    } finally {
      client.release();
    }
  });

  prot.get("/reports/cash-summary", async (req: Request, res: Response) => {
    const tzDay = (req.query.date as string) || new Date().toISOString().slice(0, 10);
    const day = new Date(tzDay + "T12:00:00");
    const { start, end } = dayBounds(day);
    const pool = getPool();
    const byMethod = await pool.query(
      `SELECT payment_method, type,
              COALESCE(SUM(amount),0)::float8 total
       FROM pos_transactions
       WHERE created_at >= $1 AND created_at <= $2
       GROUP BY payment_method, type`,
      [start, end]
    );
    res.json({ date: tzDay, breakdown: byMethod.rows });
  });

  api.use(prot);
  app.use("/api/ops", api);
}
