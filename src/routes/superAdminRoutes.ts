import type { Express, Request, Response } from "express";
import { Router } from "express";
import { authMiddleware } from "../middleware/auth.middleware";
import { emitStoreFeaturesUpdated } from "../features/storeFeatureBroadcast";
import {
  getStoreFeaturesForStore,
  listStoresWithLabels,
  setStoreFeaturesForStore,
  verifySuperAdminPin
} from "../features/storeFeatureStore";
import { deleteTenantFromDisk } from "../tenant/tenantDeletion";
import { reloadAllCachesAfterTenantDeletion } from "./posApi";
import type { StoreFeatures } from "../features/storeFeatureModel";
import { STORE_FEATURE_KEYS } from "../features/storeFeatureModel";

function requireSuperAdmin(req: Request, res: Response, next: () => void): void {
  if (req.user?.role !== "super_admin") {
    res.status(403).json({ error: "Forbidden", message: "Super admin only" });
    return;
  }
  next();
}

function pinHeader(req: Request): string | undefined {
  const h = req.headers["x-super-admin-pin"];
  return typeof h === "string" ? h : undefined;
}

export function registerSuperAdminRoutes(app: Express): void {
  const r = Router();
  r.use(authMiddleware);
  r.use(requireSuperAdmin);

  /** List stores (folders + saved feature rows) with human-readable labels from café admins. */
  r.get("/stores", (_req: Request, res: Response) => {
    res.json({ stores: listStoresWithLabels() });
  });

  r.get("/stores/:storeId/features", (req: Request, res: Response) => {
    const storeId = (req.params.storeId || "").trim();
    if (!storeId) return res.status(400).json({ error: "storeId required" });
    res.json({ storeId, features: getStoreFeaturesForStore(storeId) });
  });

  /** Remove café tenant (users, staff rows, data/stores folder, store-features row). Requires PIN when SUPER_ADMIN_PIN_HASH is set. */
  r.delete("/stores/:storeId", (req: Request, res: Response) => {
    if (!verifySuperAdminPin(pinHeader(req))) {
      return res.status(401).json({ error: "Invalid or missing PIN", code: "SUPER_ADMIN_PIN" });
    }
    const result = deleteTenantFromDisk(req.params.storeId || "");
    if (!result.ok) {
      const st =
        result.code === "NOT_FOUND"
          ? 404
          : result.code === "FORBIDDEN_TENANT" || result.code === "BAD_REQUEST"
            ? 400
            : 500;
      return res.status(st).json({ error: result.error, code: result.code });
    }
    reloadAllCachesAfterTenantDeletion();
    emitStoreFeaturesUpdated(result.storeId, getStoreFeaturesForStore(result.storeId));
    res.json({
      ok: true,
      storeId: result.storeId,
      removedUsers: result.removedUsers,
      removedStaffRecords: result.removedStaffRecords
    });
  });

  r.post("/features", (req: Request, res: Response) => {
    if (!verifySuperAdminPin(pinHeader(req))) {
      return res.status(401).json({ error: "Invalid or missing PIN", code: "SUPER_ADMIN_PIN" });
    }
    const body = req.body as { storeId?: string; features?: Partial<StoreFeatures> };
    const storeId = typeof body.storeId === "string" ? body.storeId.trim() : "";
    if (!storeId) return res.status(400).json({ error: "storeId required" });
    const patch = body.features;
    if (!patch || typeof patch !== "object") return res.status(400).json({ error: "features object required" });
    const cleaned: Partial<StoreFeatures> = {};
    for (const k of STORE_FEATURE_KEYS) {
      if (k in patch && typeof patch[k] === "boolean") cleaned[k] = patch[k];
    }
    const updated = setStoreFeaturesForStore(storeId, cleaned, {
      changedBy: req.user!.userId,
      role: req.user!.role
    });
    emitStoreFeaturesUpdated(storeId, updated);
    res.json({ ok: true, storeId, features: updated });
  });

  app.use("/api/super-admin", r);

  /** Alias per API spec — same auth + PIN as /api/super-admin/features */
  const alias = Router();
  alias.use(authMiddleware);
  alias.use(requireSuperAdmin);
  alias.post("/features", (req: Request, res: Response) => {
    if (!verifySuperAdminPin(pinHeader(req))) {
      return res.status(401).json({ error: "Invalid or missing PIN", code: "SUPER_ADMIN_PIN" });
    }
    const body = req.body as { storeId?: string; features?: Partial<StoreFeatures> };
    const storeId = typeof body.storeId === "string" ? body.storeId.trim() : "";
    if (!storeId) return res.status(400).json({ error: "storeId required" });
    const patch = body.features;
    if (!patch || typeof patch !== "object") return res.status(400).json({ error: "features object required" });
    const cleaned: Partial<StoreFeatures> = {};
    for (const k of STORE_FEATURE_KEYS) {
      if (k in patch && typeof patch[k] === "boolean") cleaned[k] = patch[k];
    }
    const updated = setStoreFeaturesForStore(storeId, cleaned, {
      changedBy: req.user!.userId,
      role: req.user!.role
    });
    emitStoreFeaturesUpdated(storeId, updated);
    res.json({ ok: true, storeId, features: updated });
  });
  app.use("/api/admin", alias);
}
