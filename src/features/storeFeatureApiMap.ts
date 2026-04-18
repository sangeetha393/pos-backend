import type { StoreFeatureKey } from "./storeFeatureModel";

/**
 * Maps API subpath (under /api, no query) + method to a feature key.
 * First match wins; return null = not gated (always allow if authenticated).
 */
type Rule = { test: (method: string, path: string) => boolean; feature: StoreFeatureKey };

function pfx(prefix: string, feature: StoreFeatureKey, methods?: string[]): Rule {
  return {
    test: (method, path) => {
      const ok = path === prefix || path.startsWith(prefix + "/");
      if (!ok) return false;
      return methods ? methods.includes(method) : true;
    },
    feature
  };
}

const RULES: Rule[] = [
  pfx("/inventory", "inventory"),
  pfx("/ingredients", "inventory"),
  pfx("/recipes", "inventory"),
  pfx("/stock", "inventory"),
  pfx("/closing-stock", "inventory"),
  pfx("/wastage", "inventory"),
  pfx("/batches", "inventory"),
  pfx("/menu/upload", "inventory"),
  pfx("/menu/ai-parse", "inventory"),
  pfx("/products/bulk-create", "inventory"),
  pfx("/purchases", "inventory"),
  pfx("/purchase-list", "inventory"),
  pfx("/loyalty", "loyalty"),
  pfx("/customers", "loyalty"),
  pfx("/analytics", "analytics"),
  pfx("/reports", "reports"),
  pfx("/transactions", "transactions"),
  pfx("/cash-control", "transactions"),
  pfx("/expenses", "expenses"),
  pfx("/cash-flow", "expenses"),
  pfx("/day-ends", "reports"),
  pfx("/feedback", "reports"),
  pfx("/reservations", "qrOrdering"),
  pfx("/waiter-calls", "qrOrdering"),
  pfx("/requests", "qrOrdering"),
  pfx("/tables/view", "qrOrdering"),
  pfx("/customer/", "qrOrdering"),
  pfx("/payments/guest-upi-pending", "billing"),
  {
    test: (m, p) =>
      m === "PATCH" && /\/orders\/[^/]+\/guest-upi-verify$/.test(p.replace(/\/$/, "")),
    feature: "billing"
  },
  pfx("/payments", "billing"),
  pfx("/bills", "billing"),
  pfx("/billing", "billing"),
  pfx("/staff", "staff"),
  pfx("/shifts", "staff"),
  pfx("/attendance", "staff"),
  pfx("/kot", "kitchen"),
  pfx("/kots", "kitchen"),
  pfx("/modifiers", "pos"),
  pfx("/sections", "pos"),
  pfx("/tables", "pos"),
  pfx("/orders", "orders"),
  pfx("/products", "pos"),
  pfx("/pos-notifications", "orders"),
  pfx("/dashboard/summary", "reports"),
  pfx("/upload", "pos")
];

export function apiPathRequiresStoreFeature(method: string, apiPath: string): StoreFeatureKey | null {
  const path = (apiPath.split("?")[0] || "/").startsWith("/")
    ? apiPath.split("?")[0]
    : "/" + apiPath.split("?")[0];

  if (path === "/health" || path === "/features") return null;
  if (path.startsWith("/auth/")) return null;
  if (path === "/settings" && method.toUpperCase() === "GET") return null;
  if (path === "/settings/features" && method.toUpperCase() === "GET") return null;
  if (path === "/auth/validate" && method.toUpperCase() === "GET") return null;
  if (path === "/orders" && method.toUpperCase() === "POST") return null;
  if (path === "/products" || path.startsWith("/products/")) {
    if (method.toUpperCase() === "GET") return null;
  }

  if (path === "/settings" && method.toUpperCase() !== "GET") return null;

  const m = method.toUpperCase();
  for (const r of RULES) {
    if (r.test(m, path)) return r.feature;
  }
  return null;
}
