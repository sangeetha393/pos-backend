/**
 * Per-store SaaS feature flags — seller-controlled; defaults keep existing behavior (all enabled).
 */
export type StoreFeatureKey =
  | "pos"
  | "orders"
  | "kitchen"
  | "billing"
  | "inventory"
  | "staff"
  | "qrOrdering"
  | "loyalty"
  | "expenses"
  | "transactions"
  | "reports"
  | "analytics";

export type StoreFeatures = Record<StoreFeatureKey, boolean>;

export const STORE_FEATURE_KEYS: StoreFeatureKey[] = [
  "pos",
  "orders",
  "kitchen",
  "billing",
  "inventory",
  "staff",
  "qrOrdering",
  "loyalty",
  "expenses",
  "transactions",
  "reports",
  "analytics"
];

/** New stores / missing rows: all features on (backward compatible). */
export function defaultStoreFeatures(): StoreFeatures {
  return {
    pos: true,
    orders: true,
    kitchen: true,
    billing: true,
    inventory: true,
    staff: true,
    qrOrdering: true,
    loyalty: true,
    expenses: true,
    transactions: true,
    reports: true,
    analytics: true
  };
}

export function mergeStoreFeatures(partial: Partial<Record<string, unknown>> | null | undefined): StoreFeatures {
  const base = defaultStoreFeatures();
  if (!partial || typeof partial !== "object") return base;
  for (const k of STORE_FEATURE_KEYS) {
    const v = partial[k];
    if (typeof v === "boolean") base[k] = v;
  }
  return base;
}
