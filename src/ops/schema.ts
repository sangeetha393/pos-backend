import type { Pool } from "pg";

/** Normalized POS tables (inventory, money, stock closing, purchases). */
export async function ensureCoreSchema(pool: Pool): Promise<void> {
  await pool.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto";`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email VARCHAR(255) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL,
      role VARCHAR(32) NOT NULL DEFAULT 'staff',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS pos_orders (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      legacy_order_id VARCHAR(64),
      items JSONB NOT NULL DEFAULT '[]',
      total_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
      payment_method VARCHAR(32),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_pos_orders_created ON pos_orders (created_at);
    CREATE INDEX IF NOT EXISTS idx_pos_orders_legacy ON pos_orders (legacy_order_id);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS pos_transactions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      type VARCHAR(32) NOT NULL,
      amount NUMERIC(14,2) NOT NULL,
      payment_method VARCHAR(32),
      note TEXT,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      related_order_id UUID REFERENCES pos_orders(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT pos_transactions_type_chk CHECK (type IN ('sale', 'expense', 'deposit', 'withdrawal'))
    );
    CREATE INDEX IF NOT EXISTS idx_pos_tx_created ON pos_transactions (created_at);
    CREATE INDEX IF NOT EXISTS idx_pos_tx_type ON pos_transactions (type);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS pos_ingredients (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      legacy_key VARCHAR(64) UNIQUE,
      name VARCHAR(255) NOT NULL,
      stock_quantity NUMERIC(18,6) NOT NULL DEFAULT 0,
      unit VARCHAR(32) NOT NULL DEFAULT 'kg',
      low_stock_threshold NUMERIC(18,6) NOT NULL DEFAULT 0,
      cost_per_unit NUMERIC(14,4),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_pos_ing_name ON pos_ingredients (name);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS pos_recipes (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      product_id VARCHAR(64) NOT NULL,
      ingredient_id UUID NOT NULL REFERENCES pos_ingredients(id) ON DELETE CASCADE,
      quantity_used NUMERIC(18,6) NOT NULL,
      UNIQUE (product_id, ingredient_id)
    );
    CREATE INDEX IF NOT EXISTS idx_pos_recipes_product ON pos_recipes (product_id);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS pos_purchase_list (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      ingredient_id UUID NOT NULL REFERENCES pos_ingredients(id) ON DELETE CASCADE,
      quantity_needed NUMERIC(18,6) NOT NULL,
      supplier_name VARCHAR(255),
      status VARCHAR(32) NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT pos_purchase_list_status_chk CHECK (status IN ('pending', 'purchased'))
    );
    CREATE INDEX IF NOT EXISTS idx_pos_purchase_status ON pos_purchase_list (status);
    CREATE UNIQUE INDEX IF NOT EXISTS pos_purchase_one_pending_per_ing
      ON pos_purchase_list (ingredient_id) WHERE status = 'pending';
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS pos_stock_ledger (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      ingredient_id UUID NOT NULL REFERENCES pos_ingredients(id) ON DELETE CASCADE,
      opening_stock NUMERIC(18,6) NOT NULL,
      purchased_qty NUMERIC(18,6) NOT NULL DEFAULT 0,
      used_qty NUMERIC(18,6) NOT NULL DEFAULT 0,
      wasted_qty NUMERIC(18,6) NOT NULL DEFAULT 0,
      closing_stock NUMERIC(18,6) NOT NULL,
      actual_stock NUMERIC(18,6),
      ledger_date DATE NOT NULL,
      UNIQUE (ingredient_id, ledger_date)
    );
    CREATE INDEX IF NOT EXISTS idx_pos_ledger_date ON pos_stock_ledger (ledger_date);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS pos_menu_products (
      id VARCHAR(64) PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      price NUMERIC(14,2) NOT NULL DEFAULT 0,
      category VARCHAR(128),
      extra JSONB DEFAULT '{}'::jsonb
    );
  `);

  await pool.query(
    `ALTER TABLE pos_transactions ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;`
  );
}
