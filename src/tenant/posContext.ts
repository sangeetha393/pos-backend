import { AsyncLocalStorage } from "node:async_hooks";

export type PosTenantScope = {
  storeId: string;
};

const als = new AsyncLocalStorage<PosTenantScope>();

/** Resolve menu/inventory bundle for current request (set from registerRoutes). */
let bundleResolver: ((storeId: string) => unknown) | null = null;

export function registerPosBundleResolver(fn: (storeId: string) => unknown): void {
  bundleResolver = fn;
}

export function posRuntime(): AsyncLocalStorage<PosTenantScope> {
  return als;
}

export function runWithPosTenant<T>(scope: PosTenantScope, fn: () => T): T {
  return als.run(scope, fn);
}

export function getPosScope(): PosTenantScope {
  const s = als.getStore();
  if (!s?.storeId) throw new Error("Missing POS tenant scope");
  return s;
}

export function getPosBundle<T>(): T {
  const { storeId } = getPosScope();
  if (!bundleResolver) throw new Error("POS bundle resolver not registered");
  return bundleResolver(storeId) as T;
}
