/**
 * POS HTTP API — single module with two Express routers (see registerRoutes):
 * - `pub`: no JWT (health, /settings GET, /products, /products/pos, /customer/table/:tableId, full /auth/*,
 *   POST /orders, DELETE /customer/orders/:orderId/lines/:kotLineId, POST /waiter-calls, POST /requests,
 *   GET /kots?tableId=…, GET /kots/:id, GET /kitchen-display/orders)
 * - `prot`: JWT required (… + GET/PATCH `/requests` for waiter QR request queue)
 *
 * Splitting into separate files without duplicating logic requires lifting all `let`/`const`
 * that currently live inside registerRoutes (waiterCalls, staffList, inventoryMap, …) into
 * a shared domain module first.
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import multer from "multer";
import { Express, type NextFunction, Request, Response, Router } from "express";
import { authMiddleware } from "../middleware/auth.middleware";
import jwt, { type SignOptions } from "jsonwebtoken";
import bcrypt from "bcryptjs";
import Razorpay from "razorpay";
import { sendPasswordResetLinkEmail, sendPasswordChangedEmail, isEmailConfigured } from "../email";
import * as resetTokenStore from "../services/passwordResetTokenStore";
import { updateUserPasswordMysql } from "../services/userPasswordMysql";
import rateLimit from "express-rate-limit";
import type { Order, OrderItem, OrderStatus, OrderItemLineStatus, GuestPaymentStatus } from "../types/order";
import { canTransitionOrderStatus, canTransitionLineStatus, orderVisibleOnKitchenBoard } from "../types/order";
import { orders, touchOrders, nextOrderId, persistOrdersOnly } from "../orders/orderStore";
import { billExistsForOrder, createBillFromOrder, getBillById, listBillsForStore } from "../bills/guestBillStore";
import { emitPosNotification, notifyOrderCreated, emitNewOrderKot, notifyKotUpdated } from "../orders/kotNotify";
import {
  pushPosNotification,
  listPosNotifications,
  type PosNotificationAudience
} from "../orders/posNotificationStore";
import { itemMergeKey, normalizeItem, newLineId } from "../orders/orderNormalize";
import { loadCollectionBodies, replaceCollectionBodies } from "../db/postgresCollections";
import { isPostgresConfigured, isPostgresLive } from "../db/pool";
import { DATA_DIR, UPLOADS_DIR } from "../paths";
import {
  enqueueJsonWrite,
  writeJsonValueAtomicSync,
  readJsonWithRecoverySync
} from "../storage/jsonPersistence";
import { resolveTableIdFromQrParam } from "../qr/resolveTableId";
import {
  insertQrOrder,
  upsertQrCustomer,
  isMongoQrLive,
  updateQrOrderStatus
} from "../db/mongoQr";
import { getJwtSecret } from "../auth/jwtSecret";
import { getStoreFeaturesForStore } from "../features/storeFeatureStore";
import { apiPathRequiresStoreFeature } from "../features/storeFeatureApiMap";
import { jwtStoreIdForUser, storeIdFromAuthorizationHeader } from "../auth/jwtStoreId";
import { registerPosBundleResolver, runWithPosTenant, getPosScope, getPosBundle } from "../tenant/posContext";
import {
  LEGACY_DEFAULT_STORE_ID,
  migrateLegacyFilesIntoStore,
  readJsonArray,
  sanitizeStoreId,
  tenantPath,
  writeJsonFile
} from "../tenant/posStoreRegistry";
import { getOrCreateJsonPosStore, JsonPosStore, PG_SHARED_STORE_ID, seedEmptyStoreFiles } from "../tenant/jsonPosData";
import {
  DEFAULT_MAIN_SECTION_ID,
  DEFAULT_MAIN_SECTION_NAME,
  DEFAULT_STARTER_TABLE_COUNT,
  type FloorPlan,
  type FloorTable,
  isAlreadyNormalized,
  normalizeFloorPlanDoc,
  newSectionId,
  seedStarterTables,
  seedDefaultFloorPlan,
  sectionNameById
} from "../tables/floorPlan";
import { ordersForStore } from "../orders/orderStore";
import { recordPosSaleToPostgres } from "../ops/saleSync";
import * as menuExtract from "../menuImport/extractText";
import * as menuOpenAi from "../menuImport/openai";
import {
  dedupeMenuItems,
  ingredientQtyToStorage,
  normalizeIngredientKey,
  normalizeParsedIngredient
} from "../menuImport/units";
import type { ParsedMenuItem } from "../menuImport/types";
import { upsertRecipeMeta, loadRecipeProductMeta } from "../menuImport/recipeMetaStore";
import type { RecipeProductMeta } from "../menuImport/types";

const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || "";
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || "";
const razorpayInstance = RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET
  ? new Razorpay({ key_id: RAZORPAY_KEY_ID, key_secret: RAZORPAY_KEY_SECRET })
  : null;

type UserRole = "admin" | "staff" | "manager" | "chief" | "kitchen" | "super_admin";

type User = {
  id: string;
  email: string;
  /** Optional short login name (café staff / chef) — also try `staff.pos.local` synthetic emails. */
  username?: string;
  password: string;
  pin: string;
  role: UserRole;
  name?: string;
  phone?: string;
  storeName?: string;
  storeAddress?: string;
  gstNumber?: string;
  assignedStoreId?: string;
  /** Set when this login was created from Staff → links to `staff.json` id */
  staffMemberId?: string;
};

const defaultUsers: User[] = [
  { id: "U1", email: "admin@pos.com", password: "admin123", pin: "1234", role: "admin" },
  {
    id: "U2",
    email: "staff@pos.com",
    password: "staff123",
    pin: "5678",
    role: "staff",
    assignedStoreId: "U1"
  },
  { id: "U3", email: "manager@pos.com", password: "manager123", pin: "9012", role: "manager" },
  {
    id: "U4",
    email: "chef@kitchen.pos.local",
    username: "chef",
    password: "kitchen123",
    pin: "1111",
    role: "kitchen",
    assignedStoreId: "U1"
  }
];

function signUserJwt(user: User, expiresIn: SignOptions["expiresIn"]): string {
  return jwt.sign(
    { userId: user.id, role: user.role, storeId: jwtStoreIdForUser(user) },
    getJwtSecret(),
    { expiresIn }
  );
}

const BCRYPT_ROUNDS = 10;

function isBcryptHash(p: string): boolean {
  return typeof p === "string" && (p.startsWith("$2a$") || p.startsWith("$2b$") || p.startsWith("$2y$"));
}

async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

async function comparePassword(plain: string, stored: string): Promise<boolean> {
  if (isBcryptHash(stored)) return bcrypt.compare(plain, stored);
  return plain === stored;
}

const USERS_FILE = path.join(DATA_DIR, "users.json");
const PRODUCTS_FILE = path.join(DATA_DIR, "products.json");
const INGREDIENTS_FILE = path.join(DATA_DIR, "ingredients.json");
const RECIPES_FILE = path.join(DATA_DIR, "recipes.json");
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
const DAY_ENDS_FILE = path.join(DATA_DIR, "day-ends.json");
const LOYALTY_FILE = path.join(DATA_DIR, "loyalty.json");
const TRANSACTIONS_FILE = path.join(DATA_DIR, "money-transactions.json");
const CASH_CONTROL_FILE = path.join(DATA_DIR, "cash-control.json");
const PURCHASE_LIST_FILE = path.join(DATA_DIR, "purchase-list.json");
/** Persisted menu-item stock counts (product inventory), survives server restarts. */
const PRODUCT_INVENTORY_FILE = path.join(DATA_DIR, "product-inventory.json");
/** Default on-hand qty when a product first gets an inventory row (menu / closing stock). */
const DEFAULT_PRODUCT_STOCK_QTY = 100;

type ProductInventoryRow = { productId: string; qty: number; unit: string; lowStock: number };

let productInventoryPersistTimer: ReturnType<typeof setTimeout> | null = null;

function loadProductInventoryRowsFromDisk(): ProductInventoryRow[] {
  try {
    const raw = fs.readFileSync(PRODUCT_INVENTORY_FILE, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: ProductInventoryRow[] = [];
    for (const row of parsed) {
      if (!row || typeof row !== "object") continue;
      const r = row as Record<string, unknown>;
      const productId = typeof r.productId === "string" ? r.productId.trim() : "";
      if (!productId) continue;
      out.push({
        productId,
        qty: Math.max(0, Number(r.qty) || 0),
        unit: typeof r.unit === "string" && r.unit.trim() ? r.unit.trim() : "pcs",
        lowStock: Math.max(0, Number(r.lowStock) || 10)
      });
    }
    return out;
  } catch {
    return [];
  }
}

function schedulePersistProductInventory(map: Map<string, ProductInventoryRow>): void {
  if (productInventoryPersistTimer) clearTimeout(productInventoryPersistTimer);
  productInventoryPersistTimer = setTimeout(() => {
    productInventoryPersistTimer = null;
    try {
      fs.mkdirSync(path.dirname(PRODUCT_INVENTORY_FILE), { recursive: true });
      writeJsonValueAtomicSync(PRODUCT_INVENTORY_FILE, [...map.values()]);
    } catch (e) {
      console.error("[inventory] product-inventory save failed:", e);
    }
  }, 150);
}

function persistProductInventoryImmediate(map: Map<string, ProductInventoryRow>): void {
  if (productInventoryPersistTimer) {
    clearTimeout(productInventoryPersistTimer);
    productInventoryPersistTimer = null;
  }
  try {
    fs.mkdirSync(path.dirname(PRODUCT_INVENTORY_FILE), { recursive: true });
    writeJsonValueAtomicSync(PRODUCT_INVENTORY_FILE, [...map.values()]);
  } catch (e) {
    console.error("[inventory] product-inventory immediate save failed:", e);
  }
}

/** Lifetime units sold per product id from paid (non-cancelled) orders — for stock reconciliation. */
function lifetimePaidQtyByProductId(): Map<string, number> {
  const m = new Map<string, number>();
  for (const o of orders) {
    if (!o.isPaid || o.status === "cancelled") continue;
    if (!Array.isArray(o.items)) continue;
    for (const it of o.items) {
      const pid = String(it.id ?? "").trim();
      if (!pid) continue;
      const q = Math.max(1, Math.floor(Number(it.qty) || 1));
      m.set(pid, (m.get(pid) ?? 0) + q);
    }
  }
  return m;
}

/** Set from `registerRoutes` so handlers defined earlier (e.g. POST /products) can mutate stock safely. */
let productInventoryRuntimeMap: Map<string, ProductInventoryRow> | null = null;

function seedNewProductInventoryRow(productId: string): void {
  const map = productInventoryRuntimeMap;
  if (!map || !productId.trim() || map.has(productId)) return;
  map.set(productId, { productId, qty: DEFAULT_PRODUCT_STOCK_QTY, unit: "pcs", lowStock: 10 });
  schedulePersistProductInventory(map);
}

function dropProductInventoryRow(productId: string): void {
  const map = productInventoryRuntimeMap;
  if (!map) return;
  if (map.delete(productId)) schedulePersistProductInventory(map);
}

type AppSettings = {
  currency: string;
  currencySymbol: string;
  companyName: string;
  companyAddress: string;
  companyPhone: string;
  companyEmail: string;
  companyLogoUrl: string;
  loyaltyPointsPer100: number;
  loyaltyRedeemPer100Points: number;
  /**
   * Redemption allowed on the first N visits of each cycle (e.g. 6 of 12 = visits 1–6, 13–18…).
   * Set cycle length to 0 to disable visit gating (always allow redemption if points allow).
   */
  loyaltyRedeemVisitCycleLength: number;
  loyaltyRedeemVisitActiveCount: number;
  /** When true, front-end locks inventory edits and kitchen KOT actions (chef not on duty). */
  chefAbsent: boolean;
  /** When false, POS hides dine-in tables and defaults to takeaway. Stored per-tenant in JSON mode. */
  diningEnabled: boolean;
  /** Merchant UPI VPA for guest QR checkout (e.g. cafe@upi). */
  merchantUpiVpa: string;
  /** Payee name shown in UPI apps; defaults to company name if empty. */
  merchantUpiPayeeName: string;
};
const defaultSettings: AppSettings = {
  currency: "INR",
  currencySymbol: "₹",
  companyName: "Restaurant POS",
  companyAddress: "",
  companyPhone: "",
  companyEmail: "",
  companyLogoUrl: "",
  loyaltyPointsPer100: 10,
  loyaltyRedeemPer100Points: 10,
  loyaltyRedeemVisitCycleLength: 12,
  loyaltyRedeemVisitActiveCount: 6,
  chefAbsent: false,
  diningEnabled: true,
  merchantUpiVpa: "",
  merchantUpiPayeeName: ""
};
function loadSettings(): AppSettings {
  const parsed = readJsonWithRecoverySync(
    DATA_DIR,
    SETTINGS_FILE,
    {} as Partial<AppSettings>,
    (v): v is Partial<AppSettings> => typeof v === "object" && v !== null && !Array.isArray(v)
  );
  return { ...defaultSettings, ...parsed };
}
function saveSettings(s: AppSettings): void {
  setImmediate(() => {
    try {
      fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
      writeJsonValueAtomicSync(SETTINGS_FILE, s);
    } catch (err) {
      console.error("Failed to save settings:", err);
    }
  });
}
let appSettings: AppSettings = loadSettings();

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    cb(null, UPLOADS_DIR);
  },
  filename: (_req, file, cb) => {
    const m = file.originalname.match(/\.(jpg|jpeg|png|gif|webp)$/i);
    const ext = m ? "." + m[1].toLowerCase() : ".jpg";
    cb(null, `product-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

/**
 * Tenant anchor for staff/kitchen: `assignedStoreId` must equal the café admin's user id (same value as JWT `storeId` for that admin).
 * Optional env: `DEFAULT_TENANT_ADMIN_ID` — when set, orphan staff/kitchen rows (missing `assignedStoreId`) are linked to this id on load.
 * If unset and multiple admins exist, first admin id (lexicographic) is used and a warning is logged.
 */
function pickDefaultTenantAdminId(list: User[]): string | null {
  const envId = process.env.DEFAULT_TENANT_ADMIN_ID?.trim();
  if (envId) return sanitizeStoreId(envId);
  const admins = list.filter((u) => u.role === "admin");
  if (admins.length === 1) return admins[0].id;
  if (admins.length === 0) return null;
  const legacy = admins.find((a) => a.id === LEGACY_DEFAULT_STORE_ID);
  if (legacy) return legacy.id;
  const sorted = [...admins].sort((a, b) => a.id.localeCompare(b.id));
  console.warn(
    "[users] Multiple admin accounts and DEFAULT_TENANT_ADMIN_ID is unset; assigning orphan staff/kitchen to",
    sorted[0].id,
    "(set DEFAULT_TENANT_ADMIN_ID in backend/.env to pick a specific café)"
  );
  return sorted[0].id;
}

function ensureStaffKitchenAssignedStore(list: User[]): { list: User[]; changed: boolean } {
  const defaultTenant = pickDefaultTenantAdminId(list);
  if (!defaultTenant) return { list, changed: false };
  let changed = false;
  const out = list.map((u) => {
    if ((u.role === "staff" || u.role === "kitchen") && !u.assignedStoreId?.trim()) {
      changed = true;
      return { ...u, assignedStoreId: defaultTenant };
    }
    return u;
  });
  return { list: out, changed };
}

function loadUsers(): User[] {
  const raw = readJsonWithRecoverySync(DATA_DIR, USERS_FILE, [...defaultUsers], (v): v is User[] =>
    Array.isArray(v)
  );
  const { list, changed } = ensureStaffKitchenAssignedStore(raw);
  if (changed) saveUsers(list);
  return list;
}

function saveUsers(userList: User[]): void {
  const file = USERS_FILE;
  setImmediate(() => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      void enqueueJsonWrite(file, userList);
    } catch (err) {
      console.error("Failed to save users:", err);
    }
  });
}

/** Synthetic domain for staff logins created from Staff Management (username-only sign-in). */
const STAFF_LOGIN_EMAIL_DOMAIN = "staff.pos.local";

function normalizeStaffLoginUsername(raw: string): string | null {
  const s = raw.trim().toLowerCase();
  if (!/^[a-z0-9_-]{3,32}$/.test(s)) return null;
  return s;
}

function staffSyntheticLoginEmail(username: string): string {
  return `${username}@${STAFF_LOGIN_EMAIL_DOMAIN}`;
}

let users: User[] = loadUsers();

let reloadStaffListFromDisk: (() => void) | null = null;
/** Called from `registerRoutes` once `staffList` exists — lets seller tenant delete refresh RAM. */
export function registerStaffListReload(fn: () => void): void {
  reloadStaffListFromDisk = fn;
}
export function reloadUsersFromDisk(): void {
  users = loadUsers();
}
export function reloadAllCachesAfterTenantDeletion(): void {
  users = loadUsers();
  reloadStaffListFromDisk?.();
}

/** One-time seller account from env (optional). Set SUPER_ADMIN_EMAIL + SUPER_ADMIN_PASSWORD in backend/.env */
(function bootstrapSuperAdminFromEnv(): void {
  const email = process.env.SUPER_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.SUPER_ADMIN_PASSWORD?.trim();
  if (!email || !password) return;
  if (users.some((u) => u.email.toLowerCase() === email)) return;
  const phoneDigits = (process.env.SUPER_ADMIN_PHONE || "").replace(/\D/g, "").slice(-10);
  const phone = phoneDigits.length >= 10 ? phoneDigits : undefined;
  if (phone && users.some((u) => u.phone && u.phone.replace(/\D/g, "").slice(-10) === phone)) return;
  const id = process.env.SUPER_ADMIN_USER_ID?.trim() || "SA1";
  const hash = bcrypt.hashSync(password, BCRYPT_ROUNDS);
  users.push({
    id,
    email,
    password: hash,
    pin: "0000",
    role: "super_admin",
    ...(phone ? { phone } : {})
  });
  saveUsers(users);
  console.log(
    "[auth] Created super_admin from SUPER_ADMIN_EMAIL" + (phone ? " + SUPER_ADMIN_PHONE" : "") + " (change password after first login)."
  );
})();

/** Optional env-driven chef login: KITCHEN_USERNAME, KITCHEN_PASSWORD, KITCHEN_ASSIGNED_STORE_ID (default U1). */
(function bootstrapKitchenFromEnv(): void {
  const username = process.env.KITCHEN_USERNAME?.trim().toLowerCase();
  const password = process.env.KITCHEN_PASSWORD?.trim();
  const adminId = process.env.KITCHEN_ASSIGNED_STORE_ID?.trim() || "U1";
  if (!username || !password) return;
  users = loadUsers();
  if (users.some((u) => (u.username && u.username.toLowerCase() === username) || u.email.toLowerCase() === `${username}@kitchen.pos.local`)) {
    return;
  }
  const hash = bcrypt.hashSync(password, BCRYPT_ROUNDS);
  users.push({
    id: `K${Date.now()}`,
    email: `${username}@kitchen.pos.local`,
    username,
    password: hash,
    pin: "0000",
    role: "kitchen",
    assignedStoreId: adminId
  });
  saveUsers(users);
  console.log("[auth] Created kitchen user from KITCHEN_USERNAME / KITCHEN_PASSWORD (assignedStoreId=" + adminId + ").");
})();

type Product = {
  id: string;
  name: string;
  price: number;
  category?: string;
  type?: "veg" | "non_veg" | "egg";
  modifiers?: string[];
  sku?: string;
  costPrice?: number;
  archived?: boolean;
  imageUrl?: string;
};

const defaultProducts: Product[] = [
  { id: "P1", name: "Margherita Pizza", price: 8.5, category: "Pizza", type: "veg" },
  { id: "P2", name: "Pasta Alfredo", price: 9.0, category: "Pasta", type: "veg" },
  { id: "P3", name: "Caesar Salad", price: 6.0, category: "Salads", type: "veg" },
  { id: "P4", name: "Lemonade", price: 3.0, category: "Beverages", type: "veg" },
  { id: "P5", name: "Veg Burger", price: 5.5, category: "Fast Food", type: "veg" },
  { id: "P6", name: "Cold Coffee", price: 4.0, category: "Beverages", type: "veg" },
  { id: "P7", name: "Garlic Bread", price: 4.5, category: "Sides", type: "veg" },
  { id: "P8", name: "Chicken Pizza", price: 10.0, category: "Pizza", type: "non_veg", modifiers: ["Spicy", "Less Spicy"] },
  { id: "P9", name: "Egg Omelette", price: 5.0, category: "Fast Food", type: "egg", modifiers: ["Well Done", "Soft"] }
];

function loadProducts(): Product[] {
  try {
    const data = fs.readFileSync(PRODUCTS_FILE, "utf-8");
    const parsed = JSON.parse(data);
    return Array.isArray(parsed) ? parsed : [...defaultProducts];
  } catch {
    return [...defaultProducts];
  }
}

function saveProducts(list: Product[]): void {
  if (isPostgresLive()) {
    void replaceCollectionBodies(
      "products",
      list.map((p) => ({ docId: p.id, body: p }))
    ).catch((err) => console.error("Failed to save products (PostgreSQL):", err));
    pgProducts = list;
    return;
  }
  let storeId = LEGACY_DEFAULT_STORE_ID;
  try {
    storeId = getPosScope().storeId;
  } catch {
    /* no request scope (bootstrap) */
  }
  const b = getOrCreateJsonPosStore(storeId);
  b.products = list as unknown[];
  const file = tenantPath(sanitizeStoreId(storeId), "products.json");
  setImmediate(() => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      void enqueueJsonWrite(file, b.products);
    } catch (err) {
      console.error("Failed to save products:", err);
    }
  });
}

let pgProducts: Product[] = [];

const globalModifiers = ["Extra Sugar", "Non Spicy", "Spicy", "Strong", "Less Spicy", "No Onion", "No Garlic"];

type Customer = {
  id: string;
  name: string;
  phone: string;
  email?: string;
  address?: string;
  locality?: string;
  createdAt: string;
};

const customers: Customer[] = [];

// Ingredients (raw materials) - recipe-based inventory
const INGREDIENT_UNITS = ["kg", "pcs", "litre"] as const;
type IngredientUnit = (typeof INGREDIENT_UNITS)[number];

type Ingredient = {
  id: string;
  name: string;
  unit: IngredientUnit | string;
  stock_quantity: number;
  low_stock_threshold: number;
  costPerUnit?: number;
};

function normalizeIngredientUnit(raw: string): IngredientUnit | null {
  const u = raw.trim().toLowerCase();
  if (u === "l" || u === "ltr" || u === "liter" || u === "litre") return "litre";
  if (u === "kg" || u === "kilogram" || u === "kilograms") return "kg";
  if (u === "pc" || u === "piece" || u === "pieces" || u === "pcs") return "pcs";
  if ((INGREDIENT_UNITS as readonly string[]).includes(u)) return u as IngredientUnit;
  return null;
}
/** Recipe: how much of each ingredient is used per 1 unit of product (order qty multiplies this). */
type RecipeLine = {
  productId: string;
  ingredientId: string;
  /** Same as quantity_used — amount of ingredient consumed per product unit */
  qty: number;
};
const defaultIngredients: Ingredient[] = [
  { id: "I1", name: "Flour", unit: "kg", stock_quantity: 50, low_stock_threshold: 5, costPerUnit: 0.8 },
  { id: "I2", name: "Cheese", unit: "kg", stock_quantity: 20, low_stock_threshold: 2, costPerUnit: 4 },
  { id: "I3", name: "Tomato Sauce", unit: "kg", stock_quantity: 15, low_stock_threshold: 2, costPerUnit: 2 },
  { id: "I4", name: "Lettuce", unit: "kg", stock_quantity: 10, low_stock_threshold: 1, costPerUnit: 1.5 },
  { id: "I5", name: "Lemon", unit: "kg", stock_quantity: 8, low_stock_threshold: 1, costPerUnit: 1.2 },
  { id: "I6", name: "Coffee", unit: "kg", stock_quantity: 5, low_stock_threshold: 1, costPerUnit: 12 },
  { id: "I7", name: "Bread", unit: "pcs", stock_quantity: 100, low_stock_threshold: 10, costPerUnit: 0.3 },
  { id: "I8", name: "Eggs", unit: "pcs", stock_quantity: 120, low_stock_threshold: 12, costPerUnit: 0.15 },
  { id: "I9", name: "Chicken", unit: "kg", stock_quantity: 15, low_stock_threshold: 2, costPerUnit: 6 },
  { id: "I10", name: "Pasta", unit: "kg", stock_quantity: 10, low_stock_threshold: 2, costPerUnit: 3 },
];
const defaultRecipes: RecipeLine[] = [
  { productId: "P1", ingredientId: "I1", qty: 0.2 }, { productId: "P1", ingredientId: "I2", qty: 0.1 }, { productId: "P1", ingredientId: "I3", qty: 0.05 },
  { productId: "P2", ingredientId: "I2", qty: 0.08 }, { productId: "P2", ingredientId: "I10", qty: 0.15 },
  { productId: "P3", ingredientId: "I4", qty: 0.12 },
  { productId: "P4", ingredientId: "I5", qty: 0.05 },
  { productId: "P5", ingredientId: "I7", qty: 1 }, { productId: "P5", ingredientId: "I4", qty: 0.03 },
  { productId: "P6", ingredientId: "I6", qty: 0.02 },
  { productId: "P7", ingredientId: "I7", qty: 1 }, { productId: "P7", ingredientId: "I2", qty: 0.05 },
  { productId: "P8", ingredientId: "I1", qty: 0.2 }, { productId: "P8", ingredientId: "I2", qty: 0.1 }, { productId: "P8", ingredientId: "I3", qty: 0.05 }, { productId: "P8", ingredientId: "I9", qty: 0.15 },
  { productId: "P9", ingredientId: "I8", qty: 3 },
];

function parseIngredientRow(row: unknown): Ingredient | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  const id = typeof r.id === "string" ? r.id.trim() : "";
  const name = typeof r.name === "string" ? r.name.trim() : "";
  if (!id || !name) return null;
  const sqRaw = r.stock_quantity ?? r.stockQty;
  const thRaw = r.low_stock_threshold ?? r.lowStock;
  const stock_quantity = Number(sqRaw);
  const low_stock_threshold = Number(thRaw);
  const rawUnit = typeof r.unit === "string" ? r.unit.trim() : "kg";
  const normalized = normalizeIngredientUnit(rawUnit);
  return {
    id,
    name,
    unit: normalized ?? rawUnit,
    stock_quantity: Number.isFinite(stock_quantity) ? Math.max(0, stock_quantity) : 0,
    low_stock_threshold: Number.isFinite(low_stock_threshold) ? Math.max(0, low_stock_threshold) : 0,
    ...(typeof r.costPerUnit === "number" && Number.isFinite(r.costPerUnit)
      ? { costPerUnit: r.costPerUnit }
      : {})
  };
}

function loadIngredients(): Ingredient[] {
  try {
    const data = fs.readFileSync(INGREDIENTS_FILE, "utf-8");
    const parsed = JSON.parse(data) as unknown;
    if (!Array.isArray(parsed)) return [...defaultIngredients];
    const cleaned = parsed.map(parseIngredientRow).filter((x): x is Ingredient => x != null);
    return cleaned.length ? cleaned : [...defaultIngredients];
  } catch {
    return [...defaultIngredients];
  }
}

function saveIngredients(list: Ingredient[]): void {
  if (isPostgresLive()) {
    void replaceCollectionBodies(
      "ingredients",
      list.map((x) => ({ docId: x.id, body: x }))
    ).catch((err) => console.error("Failed to save ingredients (PostgreSQL):", err));
    pgIngredients = list;
    syncPurchaseListFromInventory();
    return;
  }
  let storeId = LEGACY_DEFAULT_STORE_ID;
  try {
    storeId = getPosScope().storeId;
  } catch {
    /* bootstrap */
  }
  const b = getOrCreateJsonPosStore(storeId);
  b.ingredients = list as unknown[];
  const file = tenantPath(sanitizeStoreId(storeId), "ingredients.json");
  setImmediate(() => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      void enqueueJsonWrite(file, b.ingredients);
    } catch (err) {
      console.error("Failed to save ingredients:", err);
    }
  });
  syncPurchaseListFromInventory();
}

function parseRecipeLine(row: unknown): RecipeLine | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  const productId = String(r.productId ?? r.product_id ?? "").trim();
  const ingredientId = String(r.ingredientId ?? r.ingredient_id ?? "").trim();
  const qtyRaw = r.qty ?? r.quantity_used;
  const qty = Number(qtyRaw);
  if (!productId || !ingredientId || !Number.isFinite(qty) || qty < 0) return null;
  return { productId, ingredientId, qty };
}

function loadRecipes(): RecipeLine[] {
  try {
    const data = fs.readFileSync(RECIPES_FILE, "utf-8");
    const parsed = JSON.parse(data) as unknown;
    if (!Array.isArray(parsed)) return [...defaultRecipes];
    const cleaned = parsed.map(parseRecipeLine).filter((x): x is RecipeLine => x != null);
    return cleaned.length ? cleaned : [...defaultRecipes];
  } catch {
    return [...defaultRecipes];
  }
}

function saveRecipes(list: RecipeLine[]): void {
  if (isPostgresLive()) {
    void replaceCollectionBodies(
      "recipes",
      list.map((r) => ({ docId: `${r.productId}:${r.ingredientId}`, body: r }))
    ).catch((err) => console.error("Failed to save recipes (PostgreSQL):", err));
    pgRecipes = list;
    return;
  }
  let storeId = LEGACY_DEFAULT_STORE_ID;
  try {
    storeId = getPosScope().storeId;
  } catch {
    /* bootstrap */
  }
  const b = getOrCreateJsonPosStore(storeId);
  b.recipes = list as unknown[];
  const file = tenantPath(sanitizeStoreId(storeId), "recipes.json");
  setImmediate(() => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      void enqueueJsonWrite(file, b.recipes);
    } catch (err) {
      console.error("Failed to save recipes:", err);
    }
  });
}

let pgIngredients: Ingredient[] = [];
let pgRecipes: RecipeLine[] = [];

function menuProducts(): Product[] {
  if (isPostgresLive()) return pgProducts;
  try {
    return getPosBundle<JsonPosStore>().products as Product[];
  } catch {
    return pgProducts;
  }
}

function menuIngredients(): Ingredient[] {
  if (isPostgresLive()) return pgIngredients;
  try {
    return getPosBundle<JsonPosStore>().ingredients as Ingredient[];
  } catch {
    return pgIngredients;
  }
}

function menuRecipes(): RecipeLine[] {
  if (isPostgresLive()) return pgRecipes;
  try {
    return getPosBundle<JsonPosStore>().recipes as RecipeLine[];
  } catch {
    return pgRecipes;
  }
}

let pgFloorPlan: FloorPlan = seedDefaultFloorPlan();

function persistStoreTablesDoc(b: JsonPosStore, plan: FloorPlan): void {
  if (isPostgresLive()) return;
  writeJsonFile(tenantPath(sanitizeStoreId(b.storeId), "tables.json"), plan);
}

function flushFloorPlanToDisk(): void {
  if (isPostgresLive()) return;
  try {
    const b = getPosBundle<JsonPosStore>();
    const plan = normalizeFloorPlanDoc(b.tables);
    b.tables = plan;
    persistStoreTablesDoc(b, plan);
  } catch (_) {
    /* no tenant scope */
  }
}

/** Dining areas + tables: per-store JSON document, or `pgFloorPlan` when PostgreSQL is live. */
function menuFloorPlan(): FloorPlan {
  if (isPostgresLive()) return pgFloorPlan;
  try {
    const b = getPosBundle<JsonPosStore>();
    const plan = normalizeFloorPlanDoc(b.tables);
    let changed = !isAlreadyNormalized(b.tables, plan);
    if (plan.tables.length === 0) {
      const sectionId = plan.sections[0]?.id || DEFAULT_MAIN_SECTION_ID;
      plan.tables = seedStarterTables(sectionId, DEFAULT_STARTER_TABLE_COUNT);
      changed = true;
    }
    // Always set bundle.tables to the normalized plan. Otherwise, when the file was
    // already normalized, `changed` is false and we returned a fresh object from
    // normalizeFloorPlanDoc while b.tables stayed stale — POST /sections etc.
    // mutated a detached copy and flushFloorPlanToDisk re-serialized the old plan.
    b.tables = plan;
    if (changed) {
      persistStoreTablesDoc(b, plan);
    }
    return plan;
  } catch {
    return seedDefaultFloorPlan();
  }
}

function menuTables(): FloorTable[] {
  return menuFloorPlan().tables;
}

async function hydrateProductsFromStorage(): Promise<void> {
  if (isPostgresLive()) {
    let rows = (await loadCollectionBodies("products")) as Product[];
    if (!rows.length && fs.existsSync(PRODUCTS_FILE)) {
      rows = loadProducts();
      if (rows.length) {
        await replaceCollectionBodies(
          "products",
          rows.map((p) => ({ docId: p.id, body: p }))
        );
      }
    }
    if (!rows.length) {
      rows = [...defaultProducts];
      await replaceCollectionBodies(
        "products",
        rows.map((p) => ({ docId: p.id, body: p }))
      );
    }
    pgProducts = rows;
    return;
  }
  const b = getOrCreateJsonPosStore(LEGACY_DEFAULT_STORE_ID);
  if (!b.products.length) {
    b.products = JSON.parse(JSON.stringify(defaultProducts)) as unknown[];
    writeJsonFile(tenantPath(b.storeId, "products.json"), b.products);
  }
}

async function hydrateIngredientsFromStorage(): Promise<void> {
  if (isPostgresLive()) {
    let rows = (await loadCollectionBodies("ingredients")) as Ingredient[];
    if (!rows.length && fs.existsSync(INGREDIENTS_FILE)) {
      rows = loadIngredients();
      if (rows.length) {
        await replaceCollectionBodies(
          "ingredients",
          rows.map((x) => ({ docId: x.id, body: x }))
        );
      }
    }
    if (!rows.length) {
      rows = [...defaultIngredients];
      await replaceCollectionBodies(
        "ingredients",
        rows.map((x) => ({ docId: x.id, body: x }))
      );
    }
    pgIngredients = rows;
    return;
  }
  const b = getOrCreateJsonPosStore(LEGACY_DEFAULT_STORE_ID);
  if (!b.ingredients.length) {
    b.ingredients = JSON.parse(JSON.stringify(defaultIngredients)) as unknown[];
    writeJsonFile(tenantPath(b.storeId, "ingredients.json"), b.ingredients);
  }
}

async function hydrateRecipesFromStorage(): Promise<void> {
  if (isPostgresLive()) {
    let rows = (await loadCollectionBodies("recipes")) as RecipeLine[];
    if (!rows.length && fs.existsSync(RECIPES_FILE)) {
      rows = loadRecipes();
      if (rows.length) {
        await replaceCollectionBodies(
          "recipes",
          rows.map((r) => ({ docId: `${r.productId}:${r.ingredientId}`, body: r }))
        );
      }
    }
    if (!rows.length) {
      rows = [...defaultRecipes];
      await replaceCollectionBodies(
        "recipes",
        rows.map((r) => ({ docId: `${r.productId}:${r.ingredientId}`, body: r }))
      );
    }
    pgRecipes = rows;
    return;
  }
  const b = getOrCreateJsonPosStore(LEGACY_DEFAULT_STORE_ID);
  if (!b.recipes.length) {
    b.recipes = JSON.parse(JSON.stringify(defaultRecipes)) as unknown[];
    writeJsonFile(tenantPath(b.storeId, "recipes.json"), b.recipes);
  }
}

/** Call from `index.ts` after `initOrderStore()` and before `registerRoutes()`. */
export async function bootstrapPosMenuInventoryPersistence(): Promise<void> {
  registerPosBundleResolver((id) =>
    getOrCreateJsonPosStore(isPostgresLive() ? PG_SHARED_STORE_ID : sanitizeStoreId(id))
  );
  if (!isPostgresLive()) {
    migrateLegacyFilesIntoStore(LEGACY_DEFAULT_STORE_ID, [
      { name: "products.json", path: PRODUCTS_FILE },
      { name: "ingredients.json", path: INGREDIENTS_FILE },
      { name: "recipes.json", path: RECIPES_FILE },
      { name: "settings.json", path: SETTINGS_FILE },
      { name: "product-inventory.json", path: PRODUCT_INVENTORY_FILE }
    ]);
  }
  await hydrateProductsFromStorage();
  await hydrateIngredientsFromStorage();
  await hydrateRecipesFromStorage();
  if (isPostgresLive()) {
    const b = getOrCreateJsonPosStore(PG_SHARED_STORE_ID);
    b.products = pgProducts as unknown[];
    b.ingredients = pgIngredients as unknown[];
    b.recipes = pgRecipes as unknown[];
    console.log(
      `[persist] ${pgProducts.length} products, ${pgIngredients.length} ingredients, ${pgRecipes.length} recipe rows → PostgreSQL`
    );
  } else if (isPostgresConfigured()) {
    console.warn(
      "[persist] DATABASE_URL is set but PostgreSQL did not connect — using JSON files. Fix DB or remove DATABASE_URL."
    );
  } else {
    console.warn(
      "[persist] DATABASE_URL not set — using JSON files for menu/inventory. Set DATABASE_URL for PostgreSQL."
    );
  }
}

/** Sum ingredient demand for ordered products (recipe qty × order line qty). */
function aggregateIngredientNeedsForOrder(items: { id: string; qty: number }[]): Map<string, number> {
  const needs = new Map<string, number>();
  for (const item of items) {
    if (!item?.id) continue;
    const orderQty = Math.max(1, Math.floor(Number(item.qty) || 1));
    const lines = menuRecipes().filter((r) => r && r.productId === item.id);
    for (const line of lines) {
      if (!line?.ingredientId || !Number.isFinite(line.qty)) continue;
      const need = line.qty * orderQty;
      if (!Number.isFinite(need) || need <= 0) continue;
      const cur = needs.get(line.ingredientId) ?? 0;
      needs.set(line.ingredientId, cur + need);
    }
  }
  return needs;
}

/**
 * Deduct up to `need` from ingredient stock (FIFO batches, then main stock).
 * Never drives stock below 0. Returns how much was actually removed.
 */
function deductIngredientAmount(ingredientId: string, need: number): number {
  if (!Number.isFinite(need) || need <= 0) return 0;
  const ing = menuIngredients().find((i) => i != null && i.id === ingredientId);
  if (!ing) return 0;
  const onHand = Math.max(0, Number(ing.stock_quantity) || 0);
  const toDeduct = Math.min(need, onHand);
  if (toDeduct <= 0) return 0;
  deductFromBatches(ingredientId, toDeduct);
  ing.stock_quantity = Math.max(0, ing.stock_quantity - toDeduct);
  return toDeduct;
}

type InventoryDeductionResult = {
  shortfalls: { ingredientId: string; requested: number; deducted: number }[];
};

/**
 * Apply recipe-based deduction for order lines; persists nothing — caller must saveIngredients.
 * Used when finalizing payment (billing) so stock matches completed sales.
 */
function deductIngredientsForOrder(items: { id: string; qty: number }[]): InventoryDeductionResult {
  const needs = aggregateIngredientNeedsForOrder(items);
  const shortfalls: InventoryDeductionResult["shortfalls"] = [];
  for (const [ingredientId, totalNeed] of needs) {
    const deducted = deductIngredientAmount(ingredientId, totalNeed);
    if (deducted < totalNeed - 1e-9) {
      shortfalls.push({
        ingredientId,
        requested: Math.round(totalNeed * 1000) / 1000,
        deducted: Math.round(deducted * 1000) / 1000
      });
    }
  }
  return { shortfalls };
}

/** Lookback window for average daily ingredient usage (from paid sales). */
const INVENTORY_RUNOUT_LOOKBACK_DAYS = 7;

/** Ingredient quantities consumed via recipes from paid orders in the last N days. */
function computeIngredientUsageFromSalesLastNDays(nDays: number): Map<string, number> {
  const cutoff = Date.now() - nDays * 24 * 60 * 60 * 1000;
  const recentOrders = orders.filter((o) => {
    if (!o.isPaid || o.status === "cancelled") return false;
    return new Date(o.createdAt).getTime() >= cutoff;
  });
  const usage = new Map<string, number>();
  for (const o of recentOrders) {
    for (const item of o.items) {
      const qty = Math.max(1, Math.floor(Number(item.qty) || 1));
      for (const r of menuRecipes().filter((r) => r && r.productId === item.id)) {
        if (!r.ingredientId || !Number.isFinite(r.qty)) continue;
        const cur = usage.get(r.ingredientId) ?? 0;
        usage.set(r.ingredientId, cur + r.qty * qty);
      }
    }
  }
  return usage;
}

/** Paid (non-cancelled) orders whose createdAt falls in [fromMs, toMs]. */
function paidOrdersInLocalRange(fromMs: number, toMs: number): Order[] {
  return orders.filter((o) => {
    if (!o.isPaid || o.status === "cancelled") return false;
    const t = new Date(o.createdAt).getTime();
    return t >= fromMs && t <= toMs;
  });
}

function aggregateItemsSoldForClosingStock(paidList: Order[]): {
  id: string;
  name: string;
  qty: number;
  revenue: number;
}[] {
  /** One row per menu item that was actually sold — key by product id, or by name if id missing. */
  const m = new Map<string, { id: string; name: string; qty: number; revenue: number }>();
  for (const o of paidList) {
    for (const it of o.items) {
      const idRaw = String(it.id ?? "").trim();
      const name = String(it.name || idRaw || "Item").trim() || "Item";
      const mapKey = idRaw || `__n:${name.toLowerCase()}`;
      const displayId = idRaw || name;
      const qty = Math.max(1, Math.floor(Number(it.qty) || 1));
      const price = Number(it.price) || 0;
      const cur = m.get(mapKey);
      const addRev = Math.round(price * qty * 100) / 100;
      if (cur) {
        cur.qty += qty;
        cur.revenue = Math.round((cur.revenue + addRev) * 100) / 100;
      } else {
        m.set(mapKey, { id: displayId, name, qty, revenue: addRev });
      }
    }
  }
  return [...m.values()]
    .filter((r) => r.qty > 0)
    .sort((a, b) => b.revenue - a.revenue);
}

/** One row per sold line on paid bills — KOT / invoice register style (newest first). */
function flattenSoldLinesForClosingStock(paidList: Order[]): {
  orderId: string;
  kotNo: number;
  createdAt: string;
  tableId: string;
  channel: string;
  itemName: string;
  productId: string;
  qty: number;
  lineTotal: number;
}[] {
  const rows: {
    orderId: string;
    kotNo: number;
    createdAt: string;
    tableId: string;
    channel: string;
    itemName: string;
    productId: string;
    qty: number;
    lineTotal: number;
  }[] = [];
  for (const o of paidList) {
    const kotNo = parseInt(String(o.id).replace(/\D/g, ""), 10) || 0;
    const channel =
      o.tableId === "DELIVERY"
        ? "Delivery"
        : o.tableId === "TAKEAWAY"
          ? "Pick up"
          : `Dine-in · ${o.tableId.replace(/\D/g, "") || o.tableId}`;
    for (const it of o.items) {
      const qty = Math.max(1, Math.floor(Number(it.qty) || 1));
      const price = Number(it.price) || 0;
      rows.push({
        orderId: o.id,
        kotNo,
        createdAt: o.createdAt,
        tableId: o.tableId,
        channel,
        itemName: String(it.name || it.id),
        productId: String(it.id ?? ""),
        qty,
        lineTotal: Math.round(price * qty * 100) / 100
      });
    }
  }
  rows.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  return rows;
}

function aggregateIngredientConsumptionForClosingStock(paidList: Order[]): {
  ingredientId: string;
  name: string;
  unit: string;
  consumed: number;
}[] {
  const usage = new Map<string, number>();
  for (const o of paidList) {
    const lines = o.items.map((i) => ({
      id: i.id,
      qty: Math.max(1, Math.floor(Number(i.qty) || 1))
    }));
    const needs = aggregateIngredientNeedsForOrder(lines);
    for (const [ingredientId, q] of needs) {
      usage.set(ingredientId, (usage.get(ingredientId) ?? 0) + q);
    }
  }
  const out: { ingredientId: string; name: string; unit: string; consumed: number }[] = [];
  for (const [ingredientId, consumed] of usage) {
    const ing = menuIngredients().find((i) => i != null && i.id === ingredientId);
    if (!ing) continue;
    out.push({
      ingredientId,
      name: ing.name,
      unit: String(ing.unit),
      consumed: Math.round(consumed * 1000) / 1000
    });
  }
  out.sort((a, b) => b.consumed - a.consumed);
  return out;
}

type InventoryRunoutAlert = {
  ingredientId: string;
  name: string;
  unit: string;
  stock_quantity: number;
  avgDailyUsage: number;
  /** Estimated full days left at current avg daily usage; 0 = today / out */
  daysRemaining: number | null;
  message: string;
};

/**
 * Uses last 7 days of paid sales → average daily usage per ingredient → stock ÷ avg = days left.
 * Only lists ingredients used in a recipe; caps at ~2 weeks horizon for the alert list.
 */
function buildInventoryRunoutAlerts(): InventoryRunoutAlert[] {
  const days = INVENTORY_RUNOUT_LOOKBACK_DAYS;
  const usageByIng = computeIngredientUsageFromSalesLastNDays(days);
  const list: InventoryRunoutAlert[] = [];

  for (const ing of menuIngredients()) {
    const inRecipe = menuRecipes().some((r) => r.ingredientId === ing.id);
    if (!inRecipe) continue;

    const totalUsed = usageByIng.get(ing.id) ?? 0;
    const avgDaily = totalUsed / days;
    const stock = Math.max(0, Number(ing.stock_quantity) || 0);

    if (stock <= 0) {
      list.push({
        ingredientId: ing.id,
        name: ing.name,
        unit: String(ing.unit),
        stock_quantity: stock,
        avgDailyUsage: Math.round(avgDaily * 1000) / 1000,
        daysRemaining: 0,
        message: `${ing.name} is out of stock`
      });
      continue;
    }

    if (avgDaily <= 0) continue;

    const daysLeftRaw = stock / avgDaily;
    const daysFloored = Math.max(0, Math.floor(daysLeftRaw));

    let message: string;
    if (daysFloored <= 0) {
      message = `${ing.name} could run out today`;
    } else if (daysFloored === 1) {
      message = `${ing.name} will run out in 1 day`;
    } else {
      message = `${ing.name} will run out in ${daysFloored} days`;
    }

    if (daysFloored > 14) continue;

    list.push({
      ingredientId: ing.id,
      name: ing.name,
      unit: String(ing.unit),
      stock_quantity: Math.round(stock * 1000) / 1000,
      avgDailyUsage: Math.round(avgDaily * 1000) / 1000,
      daysRemaining: Math.round(daysLeftRaw * 10) / 10,
      message
    });
  }

  list.sort((a, b) => {
    const da = a.daysRemaining ?? 999;
    const db = b.daysRemaining ?? 999;
    return da - db;
  });
  return list.slice(0, 20);
}

type Batch = {
  id: string;
  ingredientId: string;
  qty: number;
  remainingQty: number;
  expiryDate: string;
  purchaseId: string;
};
const batches: Batch[] = [];

function deductFromBatches(ingredientId: string, amount: number): number {
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  let left = amount;
  const sorted = batches
    .filter(
      (b) =>
        b != null &&
        typeof b === "object" &&
        b.ingredientId === ingredientId &&
        Number(b.remainingQty) > 0
    )
    .sort((a, b) => new Date(a.expiryDate).getTime() - new Date(b.expiryDate).getTime());
  for (const b of sorted) {
    if (left <= 0) break;
    const take = Math.min(Number(b.remainingQty) || 0, left);
    b.remainingQty -= take;
    left -= take;
  }
  return amount - left;
}

type Purchase = {
  id: string;
  ingredientId: string;
  qty: number;
  supplier?: string;
  billNo?: string;
  cost?: number;
  expiryDate?: string;
  createdAt: string;
  /** Money ledger expense row created when cost &gt; 0 */
  expenseTransactionId?: string;
};
type Wastage = {
  id: string;
  /** Raw-material wastage (mutually exclusive with productId). */
  ingredientId?: string;
  /** Finished menu item / product stock wastage (mutually exclusive with ingredientId). */
  productId?: string;
  qty: number;
  reason: string;
  note?: string;
  createdAt: string;
};
const purchases: Purchase[] = [];
const wastages: Wastage[] = [];

/** Reorder / shopping list for ingredients (persisted). */
type PurchaseListStatus = "pending" | "ordered" | "purchased";
type PurchaseListRow = {
  id: string;
  ingredient_id: string;
  quantity_needed: number;
  supplier_name?: string;
  status: PurchaseListStatus;
  created_at: string;
  /** Set when row was created/updated by low-stock sync (vs manual add). */
  source?: "sync" | "manual";
};
let purchaseListRows: PurchaseListRow[] = [];

function parsePurchaseListRow(row: unknown): PurchaseListRow | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  const id = typeof r.id === "string" ? r.id.trim() : "";
  const ingredient_id = typeof r.ingredient_id === "string" ? r.ingredient_id.trim() : "";
  const q = Number(r.quantity_needed);
  const st = r.status;
  const created_at = typeof r.created_at === "string" ? r.created_at : new Date().toISOString();
  if (!id || !ingredient_id || !Number.isFinite(q) || q <= 0) return null;
  if (st !== "pending" && st !== "ordered" && st !== "purchased") return null;
  const src = r.source;
  const source =
    src === "sync" || src === "manual" ? src : undefined;
  return {
    id,
    ingredient_id,
    quantity_needed: Math.round(q * 1000) / 1000,
    supplier_name:
      typeof r.supplier_name === "string" && r.supplier_name.trim() ? r.supplier_name.trim() : undefined,
    status: st,
    created_at,
    ...(source ? { source } : {})
  };
}

function loadPurchaseList(): PurchaseListRow[] {
  try {
    const data = fs.readFileSync(PURCHASE_LIST_FILE, "utf-8");
    const parsed = JSON.parse(data) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map(parsePurchaseListRow).filter((x): x is PurchaseListRow => x != null);
  } catch {
    return [];
  }
}

function savePurchaseList(): void {
  setImmediate(() => {
    try {
      fs.mkdirSync(path.dirname(PURCHASE_LIST_FILE), { recursive: true });
      writeJsonValueAtomicSync(PURCHASE_LIST_FILE, purchaseListRows);
    } catch (err) {
      console.error("Failed to save purchase list:", err);
    }
  });
}

purchaseListRows = loadPurchaseList();

function roundPurchaseQty(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Suggested order qty: cover gap above threshold and/or ~7 days usage from paid sales. */
function computeSuggestedReorderQuantity(ing: Ingredient, usageByIng: Map<string, number>): number {
  const days = INVENTORY_RUNOUT_LOOKBACK_DAYS;
  const stock = Math.max(0, Number(ing.stock_quantity) || 0);
  const thr = Math.max(0, Number(ing.low_stock_threshold) || 0);
  const totalUsed = usageByIng.get(ing.id) ?? 0;
  const avgDaily = totalUsed / days;
  const gapAboveThreshold = Math.max(0, thr - stock + 1e-9);
  const weeklyUsage = avgDaily * days;
  let suggested = Math.max(gapAboveThreshold, weeklyUsage);
  if (suggested < 1e-6) {
    suggested = Math.max(thr || 1, 1);
  }
  return roundPurchaseQty(Math.max(0.01, suggested));
}

function findActivePurchaseRowForIngredient(ingredientId: string): PurchaseListRow | undefined {
  return purchaseListRows.find(
    (r) => r.ingredient_id === ingredientId && (r.status === "pending" || r.status === "ordered")
  );
}

/**
 * When stock <= low_stock_threshold, ensure one pending/ordered row (source sync) with usage-based qty.
 * Removes sync rows when stock recovers above threshold. Does not duplicate manual rows or overwrite manual qty.
 */
function syncPurchaseListFromInventory(): void {
  const usageByIng = computeIngredientUsageFromSalesLastNDays(INVENTORY_RUNOUT_LOOKBACK_DAYS);
  let changed = false;

  for (let i = purchaseListRows.length - 1; i >= 0; i--) {
    const row = purchaseListRows[i];
    if (row.status === "purchased") continue;
    if (row.source !== "sync") continue;
    const ing = menuIngredients().find((x) => x.id === row.ingredient_id);
    if (!ing) continue;
    const stock = Math.max(0, Number(ing.stock_quantity) || 0);
    const thr = Math.max(0, Number(ing.low_stock_threshold) || 0);
    if (stock > thr) {
      purchaseListRows.splice(i, 1);
      changed = true;
    }
  }

  for (const ing of menuIngredients()) {
    const stock = Math.max(0, Number(ing.stock_quantity) || 0);
    const thr = Math.max(0, Number(ing.low_stock_threshold) || 0);
    if (stock > thr) continue;

    const row = findActivePurchaseRowForIngredient(ing.id);
    const qty = computeSuggestedReorderQuantity(ing, usageByIng);

    if (row) {
      if (row.source === "manual" || row.source === undefined) {
        continue;
      }
      if (row.source === "sync") {
        const q = roundPurchaseQty(qty);
        if (Math.abs(row.quantity_needed - q) > 1e-6) {
          row.quantity_needed = q;
          changed = true;
        }
      }
    } else {
      const maxId = purchaseListRows.reduce((m, x) => {
        const n = parseInt(String(x.id).replace(/\D/g, ""), 10) || 0;
        return Math.max(m, n);
      }, 0);
      purchaseListRows.push({
        id: `PL${maxId + 1}`,
        ingredient_id: ing.id,
        quantity_needed: roundPurchaseQty(qty),
        status: "pending",
        created_at: new Date().toISOString(),
        source: "sync"
      });
      changed = true;
    }
  }

  if (changed) savePurchaseList();
}

syncPurchaseListFromInventory();

type Payment = {
  id: string;
  orderId: string;
  method: "cash" | "card" | "upi" | "qr";
  amount: number;
  staffId?: string;
  createdAt: string;
  /** Client-generated idempotency key (offline sync / retries). */
  clientIdempotencyKey?: string;
};

const payments: Payment[] = [];

/** Ledger: sales (from billing), expenses, drawer deposit/withdrawal — persisted to disk. */
type MoneyTxType = "sale" | "expense" | "deposit" | "withdrawal";
type MoneyPaymentMethod = "cash" | "card" | "upi";

type MoneyTransaction = {
  id: string;
  type: MoneyTxType;
  amount: number;
  payment_method: MoneyPaymentMethod;
  note?: string;
  created_at: string;
};

let moneyTransactions: MoneyTransaction[] = [];

function loadMoneyTransactions(): MoneyTransaction[] {
  try {
    const data = fs.readFileSync(TRANSACTIONS_FILE, "utf-8");
    const parsed = JSON.parse(data) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (row): row is MoneyTransaction =>
        !!row &&
        typeof row === "object" &&
        typeof (row as MoneyTransaction).id === "string" &&
        typeof (row as MoneyTransaction).type === "string" &&
        typeof (row as MoneyTransaction).amount === "number" &&
        typeof (row as MoneyTransaction).payment_method === "string" &&
        typeof (row as MoneyTransaction).created_at === "string"
    );
  } catch {
    return [];
  }
}

function saveMoneyTransactions(): void {
  const file = TRANSACTIONS_FILE;
  setImmediate(() => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      writeJsonValueAtomicSync(file, moneyTransactions);
    } catch (err) {
      console.error("Failed to save money transactions:", err);
    }
  });
}

function nextMoneyTxId(): string {
  const max = moneyTransactions.reduce((m, t) => {
    const n = parseInt(String(t.id).replace(/\D/g, ""), 10) || 0;
    return Math.max(m, n);
  }, 0);
  return `TX${max + 1}`;
}

function mapPaymentMethodToMoneyTx(m: Payment["method"]): MoneyPaymentMethod {
  if (m === "qr") return "upi";
  return m;
}

function recordMoneyTransaction(
  partial: Omit<MoneyTransaction, "id" | "created_at"> & { id?: string }
): MoneyTransaction {
  const amt = Math.abs(Number(partial.amount) || 0);
  const t: MoneyTransaction = {
    id: partial.id ?? nextMoneyTxId(),
    type: partial.type,
    amount: amt,
    payment_method: partial.payment_method,
    ...(partial.note ? { note: partial.note } : {}),
    created_at: new Date().toISOString()
  };
  moneyTransactions.push(t);
  saveMoneyTransactions();
  return t;
}

moneyTransactions = loadMoneyTransactions();

type MoneyDaySummary = {
  sales: number;
  expenses: number;
  net: number;
  salesCash: number;
  salesUpi: number;
  salesCard: number;
};

function previousCalendarDay(dateStr: string): string {
  const d = new Date(`${dateStr}T12:00:00`);
  d.setDate(d.getDate() - 1);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function aggregateMoneyDay(dateStr: string): MoneyDaySummary {
  const empty: MoneyDaySummary = {
    sales: 0,
    expenses: 0,
    net: 0,
    salesCash: 0,
    salesUpi: 0,
    salesCard: 0
  };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return empty;
  const fromMs = new Date(`${dateStr}T00:00:00.000`).getTime();
  const toMs = new Date(`${dateStr}T23:59:59.999`).getTime();
  let sales = 0;
  let expenses = 0;
  let salesCash = 0;
  let salesUpi = 0;
  let salesCard = 0;
  for (const t of moneyTransactions) {
    const x = new Date(t.created_at).getTime();
    if (x < fromMs || x > toMs) continue;
    const a = Number(t.amount) || 0;
    if (t.type === "sale") {
      sales += a;
      if (t.payment_method === "cash") salesCash += a;
      else if (t.payment_method === "upi") salesUpi += a;
      else if (t.payment_method === "card") salesCard += a;
    } else if (t.type === "expense") {
      expenses += a;
    }
  }
  return {
    sales,
    expenses,
    net: sales - expenses,
    salesCash,
    salesUpi,
    salesCard
  };
}

/** Sum of money-ledger sales & expenses between two dates (inclusive). Single source for P&amp;L. */
function aggregateMoneyLedgerRange(
  from: Date,
  to: Date
): { sales: number; expenses: number; net: number } {
  const fromMs = from.getTime();
  const toMs = to.getTime();
  let sales = 0;
  let expenses = 0;
  for (const t of moneyTransactions) {
    const x = new Date(t.created_at).getTime();
    if (x < fromMs || x > toMs) continue;
    const a = Number(t.amount) || 0;
    if (t.type === "sale") sales += a;
    else if (t.type === "expense") expenses += a;
  }
  return {
    sales: Math.round(sales * 100) / 100,
    expenses: Math.round(expenses * 100) / 100,
    net: Math.round((sales - expenses) * 100) / 100
  };
}

function topSellingItemsFromOrders(
  from: Date,
  to: Date,
  limit: number
): { name: string; quantity: number; revenue: number }[] {
  const fromMs = from.getTime();
  const toMs = to.getTime();
  const paid = orders.filter((o) => {
    if (!o.isPaid) return false;
    const d = new Date(o.createdAt).getTime();
    return d >= fromMs && d <= toMs;
  });
  const map = new Map<string, { name: string; quantity: number; revenue: number }>();
  for (const o of paid) {
    for (const it of o.items) {
      const key = it.id;
      const name = it.name || it.id;
      const qty = it.qty ?? 1;
      const rev = (it.price || 0) * qty;
      const cur = map.get(key) ?? { name, quantity: 0, revenue: 0 };
      cur.quantity += qty;
      cur.revenue += rev;
      map.set(key, cur);
    }
  }
  return [...map.values()]
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, limit)
    .map((x) => ({
      ...x,
      revenue: Math.round(x.revenue * 100) / 100,
      quantity: Math.round(x.quantity * 1000) / 1000
    }));
}

function buildLowStockIngredientAlerts(limit = 10): {
  ingredientId: string;
  name: string;
  unit: string;
  stock_quantity: number;
  low_stock_threshold: number;
}[] {
  return menuIngredients()
    .filter((i) => i.stock_quantity <= i.low_stock_threshold)
    .sort((a, b) => a.stock_quantity - b.stock_quantity)
    .slice(0, limit)
    .map((i) => ({
      ingredientId: i.id,
      name: i.name,
      unit: String(i.unit),
      stock_quantity: Math.round(i.stock_quantity * 1000) / 1000,
      low_stock_threshold: i.low_stock_threshold
    }));
}

function pctChangeDay(prev: number, curr: number): number | null {
  if (prev === 0 && curr === 0) return null;
  if (prev === 0) return null;
  return Math.round(((curr - prev) / prev) * 1000) / 10;
}

/** Cash drawer: opening + cash sales − cash expenses + deposits − withdrawals */
type CashMovementDay = {
  cashSales: number;
  cashExpenses: number;
  deposits: number;
  withdrawals: number;
};

function aggregateCashMovement(dateStr: string): CashMovementDay {
  const empty: CashMovementDay = { cashSales: 0, cashExpenses: 0, deposits: 0, withdrawals: 0 };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return empty;
  const fromMs = new Date(`${dateStr}T00:00:00.000`).getTime();
  const toMs = new Date(`${dateStr}T23:59:59.999`).getTime();
  for (const t of moneyTransactions) {
    const x = new Date(t.created_at).getTime();
    if (x < fromMs || x > toMs) continue;
    const a = Number(t.amount) || 0;
    if (t.type === "sale" && t.payment_method === "cash") empty.cashSales += a;
    else if (t.type === "expense" && t.payment_method === "cash") empty.cashExpenses += a;
    else if (t.type === "deposit") empty.deposits += a;
    else if (t.type === "withdrawal") empty.withdrawals += a;
  }
  return empty;
}

function listCashLedgerLines(dateStr: string, limit = 100): MoneyTransaction[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return [];
  const fromMs = new Date(`${dateStr}T00:00:00.000`).getTime();
  const toMs = new Date(`${dateStr}T23:59:59.999`).getTime();
  return moneyTransactions
    .filter((t) => {
      const x = new Date(t.created_at).getTime();
      if (x < fromMs || x > toMs) return false;
      if (t.type === "sale") return t.payment_method === "cash";
      if (t.type === "expense") return t.payment_method === "cash";
      if (t.type === "deposit" || t.type === "withdrawal") return true;
      return false;
    })
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .slice(0, limit);
}

/** Note counts for closing tally: ₹500 … ₹5 (₹1 / ₹2 coins not tracked). */
type CashDenomBreakdown = {
  n500: number;
  n100: number;
  n50: number;
  n20: number;
  n10: number;
  n5: number;
};

type CashControlStore = {
  openings: Record<string, number>;
  countedClosings: Record<string, number>;
  denominationCounts: Record<string, CashDenomBreakdown>;
};

let cashControlData: CashControlStore = {
  openings: {},
  countedClosings: {},
  denominationCounts: {}
};

function normalizeDenomEntry(raw: unknown): CashDenomBreakdown {
  if (!raw || typeof raw !== "object") {
    return { n500: 0, n100: 0, n50: 0, n20: 0, n10: 0, n5: 0 };
  }
  const o = raw as Record<string, unknown>;
  const n = (v: unknown) => Math.max(0, Math.floor(Number(v) || 0));
  return {
    n500: n(o.n500),
    n100: n(o.n100),
    n50: n(o.n50),
    n20: n(o.n20),
    n10: n(o.n10),
    n5: n(o.n5)
  };
}

function cashDenomTotal(d: CashDenomBreakdown): number {
  return (
    Math.round(
      (500 * d.n500 +
        100 * d.n100 +
        50 * d.n50 +
        20 * d.n20 +
        10 * d.n10 +
        5 * d.n5) *
        100
    ) / 100
  );
}

function loadCashControl(): CashControlStore {
  try {
    const data = fs.readFileSync(CASH_CONTROL_FILE, "utf-8");
    const p = JSON.parse(data) as Record<string, unknown>;
    const openings =
      p.openings && typeof p.openings === "object" && p.openings !== null
        ? (p.openings as Record<string, number>)
        : {};
    const countedClosings =
      p.countedClosings && typeof p.countedClosings === "object" && p.countedClosings !== null
        ? (p.countedClosings as Record<string, number>)
        : {};
    const denomRaw =
      p.denominationCounts && typeof p.denominationCounts === "object" && p.denominationCounts !== null
        ? (p.denominationCounts as Record<string, unknown>)
        : {};
    const denominationCounts: Record<string, CashDenomBreakdown> = {};
    for (const [k, v] of Object.entries(denomRaw)) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(k)) denominationCounts[k] = normalizeDenomEntry(v);
    }
    return { openings, countedClosings, denominationCounts };
  } catch {
    return { openings: {}, countedClosings: {}, denominationCounts: {} };
  }
}

function saveCashControl(): void {
  const file = CASH_CONTROL_FILE;
  setImmediate(() => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      writeJsonValueAtomicSync(file, cashControlData);
    } catch (err) {
      console.error("Failed to save cash control:", err);
    }
  });
}

cashControlData = loadCashControl();

type CashEntry = {
  id: string;
  type: "topup" | "withdrawal";
  amount: number;
  note?: string;
  createdAt: string;
};
const cashEntries: CashEntry[] = [];

type DayEnd = {
  id: string;
  date: string;
  sales: number;
  purchases: number;
  expenses: number;
  cashIn: number;
  cashOut: number;
  netCash: number;
  orderCount: number;
  closedAt: string;
};
function loadDayEnds(): DayEnd[] {
  try {
    const data = fs.readFileSync(DAY_ENDS_FILE, "utf-8");
    const parsed = JSON.parse(data);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}
function saveDayEnds(list: DayEnd[]): void {
  setImmediate(() => {
    try {
      fs.mkdirSync(path.dirname(DAY_ENDS_FILE), { recursive: true });
      writeJsonValueAtomicSync(DAY_ENDS_FILE, list);
    } catch (err) { console.error("Failed to save day ends:", err); }
  });
}
let dayEnds: DayEnd[] = loadDayEnds();

function calculateTotal(items: OrderItem[]): number {
  if (!Array.isArray(items)) return 0;
  return items.reduce((sum, item) => {
    const p = Number(item?.price);
    const q = Number(item?.qty);
    if (!Number.isFinite(p) || !Number.isFinite(q)) return sum;
    return sum + p * q;
  }, 0);
}

function orderItemsSubtotal(o: Order): number {
  return Math.round(calculateTotal(o.items) * 100) / 100;
}

/** Raw stored discount (rupees); invalid or negative → 0. */
function normalizedBillDiscountRaw(order: Order): number {
  const d = order.billDiscount;
  if (typeof d !== "number" || !Number.isFinite(d) || d < 0) return 0;
  return Math.round(d * 100) / 100;
}

function billDiscountApplied(o: Order): number {
  const sub = orderItemsSubtotal(o);
  return Math.min(normalizedBillDiscountRaw(o), sub);
}

/** Total due for the bill before loyalty redemption (items − manual discount). */
function orderInvoiceGrandTotal(o: Order): number {
  const sub = orderItemsSubtotal(o);
  return Math.max(0, Math.round((sub - billDiscountApplied(o)) * 100) / 100);
}

/** When every line is ready while order is cooking, promote order to ready. */
function syncAllItemsReadyToOrderStatus(order: Order): void {
  if (order.status === "cancelled" || order.status === "completed") return;
  if (!order.items.length) return;
  if (
    order.items.every((i) => i.lineStatus === "ready") &&
    (order.status === "cooking" || order.status === "new")
  ) {
    order.status = "ready";
    order.readyAt = order.readyAt || new Date().toISOString();
  }
}

function kotInDateRange(createdAt: string, range: string): boolean {
  const t = new Date(createdAt).getTime();
  if (!Number.isFinite(t)) return false;
  if (range === "today") {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return t >= d.getTime();
  }
  if (range === "7d") {
    return t >= Date.now() - 7 * 86400000;
  }
  return true;
}

/** Bill fell on this local calendar day (YYYY-MM-DD). */
function kotOnLocalCalendarDay(createdAt: string, ymd: string): boolean {
  const t = new Date(createdAt).getTime();
  if (!Number.isFinite(t)) return false;
  const fromMs = new Date(`${ymd}T00:00:00.000`).getTime();
  const toMs = new Date(`${ymd}T23:59:59.999`).getTime();
  return t >= fromMs && t <= toMs;
}

const CAL_YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

function localYmdFromTimestamp(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function localDayBoundsFromYmd(ymd: string): { start: Date; end: Date } {
  return {
    start: new Date(`${ymd}T00:00:00.000`),
    end: new Date(`${ymd}T23:59:59.999`)
  };
}

/** Inclusive list of YYYY-MM-DD strings from fromYmd through toYmd (local calendar). */
function expandLocalYmdRangeInclusive(fromYmd: string, toYmd: string): string[] {
  const out: string[] = [];
  const [y0, m0, d0] = fromYmd.split("-").map(Number);
  const [y1, m1, d1] = toYmd.split("-").map(Number);
  const endTs = new Date(y1, m1 - 1, d1).getTime();
  const cur = new Date(y0, m0 - 1, d0);
  while (cur.getTime() <= endTs) {
    out.push(localYmdFromTimestamp(cur.getTime()));
    cur.setDate(cur.getDate() + 1);
    if (out.length > 400) break;
  }
  return out;
}

function computeKotHistoryAnalytics(list: Order[]): { totalOrders: number; avgPrepSeconds: number | null } {
  let sumSec = 0;
  let n = 0;
  for (const o of list) {
    if (o.cookingAt && o.readyAt) {
      const a = new Date(o.cookingAt).getTime();
      const b = new Date(o.readyAt).getTime();
      if (b > a) {
        sumSec += (b - a) / 1000;
        n++;
      }
    }
  }
  return {
    totalOrders: list.length,
    avgPrepSeconds: n > 0 ? Math.round(sumSec / n) : null
  };
}

function orderTableLabelForNotification(order: Order): string {
  const floor = menuFloorPlan();
  const t = floor.tables.find((x) => x.id === order.tableId);
  if (order.tableId === "DELIVERY") return "Delivery";
  if (order.tableId === "TAKEAWAY") return "Takeaway";
  const name = t?.name?.trim();
  return name ? `${name} (${order.tableId})` : order.tableId;
}

function broadcastPosOrderNotification(
  order: Order,
  kind: string,
  title: string,
  body: string,
  audiences: PosNotificationAudience[]
): void {
  const rec = pushPosNotification({
    kind,
    title,
    body,
    audiences,
    orderId: order.id,
    tableId: order.tableId
  });
  emitPosNotification(rec);
}

function tableLabelForGuestBill(order: Order): string {
  const floor = menuFloorPlan();
  const t = floor.tables.find((x) => x.id === order.tableId);
  if (order.tableId === "DELIVERY") return "Delivery";
  if (order.tableId === "TAKEAWAY") return "Takeaway";
  return t?.name?.trim() || order.tableId;
}

/** Chef phone `new-order` broadcast — billNo is internal order id (KOT reference). */
function kotDisplayPayload(order: Order, lines: OrderItem[], merged: boolean): void {
  emitNewOrderKot({
    billNo: order.id,
    tableNo: tableLabelForGuestBill(order),
    items: lines.map((i) => ({ name: i.name, quantity: i.qty })),
    timestamp: new Date().toISOString(),
    orderId: order.id,
    merged
  });
}

function tryCreateGuestBill(order: Order): void {
  if (order.status !== "completed") return;
  if (billExistsForOrder(order.id)) return;
  createBillFromOrder(order, appSettings.companyName, tableLabelForGuestBill(order));
}

function buildUpiIntentUrl(paRaw: string, payeeName: string, amountRupees: number): string {
  const pa = paRaw.trim();
  const pn = payeeName.trim().slice(0, 80) || "Merchant";
  const am = Math.max(0, amountRupees).toFixed(2);
  const params = new URLSearchParams({ pa: pa, pn, am, cu: "INR" });
  return `upi://pay?${params.toString()}`;
}

function isValidUpiVpa(v: string): boolean {
  return /^[a-zA-Z0-9._+-]+@[a-zA-Z0-9.]+$/.test(v.trim());
}

/** Loyalty visit counter + redemption window (Settings: cycle length & active visits per cycle). */
function effectivePaidVisitCount(
  acc: { paidVisitCount?: number } | undefined,
  phone: string,
  data: { transactions: Array<{ phone: string; type: string }> }
): number {
  if (acc && typeof acc.paidVisitCount === "number" && acc.paidVisitCount >= 0) {
    return acc.paidVisitCount;
  }
  return data.transactions.filter((t) => t.phone === phone && t.type === "earn").length;
}

function loyaltyRedeemVisitRuleAllows(
  nextVisitNumber: number,
  cycleLen: number,
  activeInCycle: number
): boolean {
  if (!cycleLen || cycleLen <= 0) return true;
  if (!activeInCycle || activeInCycle <= 0) return false;
  const pos = (nextVisitNumber - 1) % cycleLen;
  return pos < activeInCycle;
}

function nextVisitWhereRedeemAllowed(fromVisit: number, cycleLen: number, activeInCycle: number): number {
  if (!cycleLen || cycleLen <= 0) return fromVisit;
  for (let v = fromVisit; v <= fromVisit + cycleLen + 5; v++) {
    if (loyaltyRedeemVisitRuleAllows(v, cycleLen, activeInCycle)) return v;
  }
  return fromVisit;
}

function analyticsRangeStartMs(range: "today" | "week" | "month"): number {
  const now = new Date();
  if (range === "today") {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  }
  if (range === "week") {
    const d = new Date(now);
    d.setDate(d.getDate() - 6);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
}

/** Kitchen logins may only call safe read methods on `/api` (GET/HEAD/OPTIONS). */
function kitchenViewOnlyApiGate(req: Request, res: Response, next: NextFunction): void {
  if (req.user?.role !== "kitchen") {
    next();
    return;
  }
  const m = (req.method || "GET").toUpperCase();
  if (m === "GET" || m === "HEAD" || m === "OPTIONS") {
    next();
    return;
  }
  res.status(403).json({ error: "Kitchen role is view-only", code: "KITCHEN_VIEW_ONLY" });
}

export function registerRoutes(app: Express) {
  const pub = Router();
  const prot = Router();

  /** Seller JWT cannot call POS tenant APIs (only /auth/validate and /super-admin/*). */
  prot.use((req: Request, res: Response, next: NextFunction) => {
    if (req.user?.role !== "super_admin") {
      next();
      return;
    }
    if (req.method === "GET" && req.path === "/auth/validate") {
      next();
      return;
    }
    /** Registered after `registerRoutes` as `app.use("/api/super-admin", …)` — must pass through this router first. */
    const p = req.path || "";
    const noQuery = (req.originalUrl || "").split("?")[0] || "";
    const isSuperAdminRoute =
      p.startsWith("/super-admin") ||
      p.startsWith("/api/super-admin") ||
      noQuery.includes("/api/super-admin");
    if (isSuperAdminRoute) {
      next();
      return;
    }
    res.status(403).json({
      error: "Seller accounts cannot use the café POS API. Open /super-admin to manage store features.",
      code: "SUPER_ADMIN_POS_BLOCKED"
    });
  });

  /** Per-store SaaS gates (see data/store-features.json). */
  prot.use((req: Request, res: Response, next: NextFunction) => {
    if (req.user?.role === "super_admin") {
      next();
      return;
    }
    /** Chef accounts only use read-only KOT APIs — don’t block on optional SaaS flags. */
    if (req.user?.role === "kitchen") {
      next();
      return;
    }
    const feat = apiPathRequiresStoreFeature(req.method, req.path);
    if (!feat) {
      next();
      return;
    }
    const flags = getStoreFeaturesForStore(req.user!.storeId);
    if (flags[feat]) {
      next();
      return;
    }
    res.status(403).json({ message: "Feature disabled", code: "FEATURE_DISABLED", feature: feat });
  });

  const guestOrderPostLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false
  });
  const guestClaimLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 80,
    standardHeaders: true,
    legacyHeaders: false
  });
  /** Per-store menu for public routes when using JSON files (customer menu / QR). PostgreSQL mode skips (shared pg bundle). */
  pub.use((req: Request, _res: Response, next: NextFunction) => {
    if (isPostgresLive()) {
      next();
      return;
    }
    const q = typeof req.query.storeId === "string" ? req.query.storeId.trim() : "";
    const qAlt = typeof req.query.store === "string" ? req.query.store.trim() : "";
    const h = req.headers["x-store-id"];
    const fromHeader = typeof h === "string" ? h.trim() : Array.isArray(h) ? String(h[0] ?? "").trim() : "";
    const sid = sanitizeStoreId(fromHeader || q || qAlt || LEGACY_DEFAULT_STORE_ID);
    runWithPosTenant({ storeId: sid }, () => next());
  });
  const menuMemoryUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 15 * 1024 * 1024 }
  });

  pub.get("/health", (_req: Request, res: Response) => {
    res.json({
      status: "ok",
      ts: new Date().toISOString(),
      postgres: isPostgresLive(),
      mongoQr: isMongoQrLive()
    });
  });

  /** Public branding / POS prefs (no secrets). Staff POS uses the same payload for GET. */
  pub.get("/settings", (_req: Request, res: Response) => {
    appSettings = loadSettings();
    let payload: AppSettings = { ...appSettings };
    if (!isPostgresLive()) {
      try {
        const b = getPosBundle<JsonPosStore>();
        const d = b.settings?.diningEnabled;
        if (typeof d === "boolean") payload = { ...payload, diningEnabled: d };
      } catch (_) {
        /* ignore */
      }
    }
    const { merchantUpiVpa: _vpa, merchantUpiPayeeName: _pn, ...publicSettings } = payload;
    void _vpa;
    void _pn;
    res.json(publicSettings);
  });

  /** Lightweight session check (all roles; avoids getPosBundle for validation-only). */
  prot.get("/auth/validate", (req: Request, res: Response) => {
    res.json({
      ok: true,
      user: { id: req.user!.userId, role: req.user!.role, storeId: req.user!.storeId }
    });
  });

  /** Admin / manager: list logins for this tenant (passwords never returned). */
  prot.get("/auth/admin/users", (req: Request, res: Response) => {
    if (req.user?.role !== "admin" && req.user?.role !== "manager") {
      return res.status(403).json({ error: "Admin access required" });
    }
    users = loadUsers();
    const tenant = req.user!.storeId;
    const list = users
      .filter((u) => u.role !== "super_admin")
      .filter((u) => {
        try {
          return jwtStoreIdForUser(u) === tenant;
        } catch {
          return false;
        }
      })
      .map((u) => ({
        id: u.id,
        email: u.email,
        username: u.username,
        role: u.role,
        assignedStoreId: u.assignedStoreId
      }));
    res.json({ users: list });
  });

  /** Admin / manager: create staff, kitchen, or another admin login for this café. */
  prot.post("/auth/admin/users", async (req: Request, res: Response) => {
    if (req.user?.role !== "admin" && req.user?.role !== "manager") {
      return res.status(403).json({ error: "Admin access required" });
    }
    const body = req.body as {
      username?: string;
      email?: string;
      password?: string;
      role?: UserRole;
      assignedStoreId?: string;
    };
    const role = body.role;
    if (role !== "staff" && role !== "kitchen" && role !== "manager" && role !== "chief") {
      return res.status(400).json({ error: "role must be staff, kitchen, manager, or chief" });
    }
    const password = typeof body.password === "string" ? body.password : "";
    if (password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });
    const emailRaw = (body.email || "").trim().toLowerCase();
    const unameRaw = (body.username || "").trim().toLowerCase();
    const username = unameRaw || (emailRaw && !emailRaw.includes("@") ? emailRaw : "");
    const email =
      emailRaw && emailRaw.includes("@")
        ? emailRaw
        : username
          ? `${username}@kitchen.pos.local`
          : "";
    if (!email) return res.status(400).json({ error: "email or username is required" });
    users = loadUsers();
    if (users.some((u) => u.email.toLowerCase() === email)) {
      return res.status(409).json({ error: "An account with this email already exists" });
    }
    if (username && users.some((u) => (u.username && u.username.toLowerCase() === username) || false)) {
      return res.status(409).json({ error: "Username already taken" });
    }
    const adminStore = req.user!.storeId;
    const assignedStoreId =
      role === "staff" || role === "kitchen"
        ? (body.assignedStoreId || "").trim() || adminStore
        : role === "chief" || role === "manager"
          ? (body.assignedStoreId || "").trim() || adminStore
          : undefined;
    const hashed = await hashPassword(password);
    const newUser: User = {
      id: `U${Date.now()}`,
      email,
      ...(username ? { username } : {}),
      password: hashed,
      pin: String(Math.floor(1000 + Math.random() * 9000)),
      role,
      ...(assignedStoreId ? { assignedStoreId } : {})
    };
    users.push(newUser);
    saveUsers(users);
    let storeId: string;
    try {
      storeId = jwtStoreIdForUser(newUser);
    } catch (e) {
      users.pop();
      saveUsers(users);
      const msg = e instanceof Error ? e.message : String(e);
      return res.status(400).json({ error: msg === "STAFF_NOT_LINKED" ? "assignedStoreId required for this role" : msg });
    }
    res.status(201).json({
      user: {
        id: newUser.id,
        email: newUser.email,
        username: newUser.username,
        role: newUser.role,
        assignedStoreId: newUser.assignedStoreId,
        storeId
      }
    });
  });

  /** Per-store SaaS feature flags (seller-controlled in data/store-features.json). */
  prot.get("/settings/features", (req: Request, res: Response) => {
    res.json({ features: getStoreFeaturesForStore(req.user!.storeId) });
  });

  /** Full settings including UPI merchant id (staff only). */
  prot.get("/settings/admin", (_req: Request, res: Response) => {
    appSettings = loadSettings();
    let payload: AppSettings = { ...appSettings };
    if (!isPostgresLive()) {
      try {
        const b = getPosBundle<JsonPosStore>();
        const d = b.settings?.diningEnabled;
        if (typeof d === "boolean") payload = { ...payload, diningEnabled: d };
      } catch (_) {
        /* ignore */
      }
    }
    res.json(payload);
  });

  prot.post("/upload", upload.single("image"), (req: Request, res: Response) => {
    if (!req.file) {
      return res.status(400).json({ error: "No image file uploaded" });
    }
    const url = `/uploads/${req.file.filename}`;
    res.json({ url });
  });

  prot.put("/settings", (req: Request, res: Response) => {
    const body = req.body as Partial<AppSettings>;
    if (typeof body.currency === "string") appSettings.currency = body.currency;
    if (typeof body.currencySymbol === "string") appSettings.currencySymbol = body.currencySymbol;
    if (typeof body.companyName === "string") appSettings.companyName = body.companyName;
    if (typeof body.companyAddress === "string") appSettings.companyAddress = body.companyAddress;
    if (typeof body.companyPhone === "string") appSettings.companyPhone = body.companyPhone;
    if (typeof body.companyEmail === "string") appSettings.companyEmail = body.companyEmail;
    if (typeof body.companyLogoUrl === "string") appSettings.companyLogoUrl = body.companyLogoUrl;
    if (typeof body.loyaltyPointsPer100 === "number" && body.loyaltyPointsPer100 >= 0) appSettings.loyaltyPointsPer100 = body.loyaltyPointsPer100;
    if (typeof body.loyaltyRedeemPer100Points === "number" && body.loyaltyRedeemPer100Points > 0) appSettings.loyaltyRedeemPer100Points = body.loyaltyRedeemPer100Points;
    if (typeof body.loyaltyRedeemVisitCycleLength === "number" && body.loyaltyRedeemVisitCycleLength >= 0) {
      appSettings.loyaltyRedeemVisitCycleLength = Math.floor(body.loyaltyRedeemVisitCycleLength);
    }
    if (typeof body.loyaltyRedeemVisitActiveCount === "number" && body.loyaltyRedeemVisitActiveCount >= 0) {
      appSettings.loyaltyRedeemVisitActiveCount = Math.floor(body.loyaltyRedeemVisitActiveCount);
    }
    if (typeof body.chefAbsent === "boolean") appSettings.chefAbsent = body.chefAbsent;
    if (typeof body.merchantUpiVpa === "string") {
      const v = body.merchantUpiVpa.trim();
      if (!v || isValidUpiVpa(v)) appSettings.merchantUpiVpa = v;
    }
    if (typeof body.merchantUpiPayeeName === "string") {
      appSettings.merchantUpiPayeeName = body.merchantUpiPayeeName.trim().slice(0, 80);
    }
    if (typeof body.diningEnabled === "boolean") {
      appSettings.diningEnabled = body.diningEnabled;
      if (!isPostgresLive()) {
        try {
          const b = getPosBundle<JsonPosStore>();
          b.settings = { ...b.settings, diningEnabled: body.diningEnabled };
          writeJsonFile(tenantPath(sanitizeStoreId(b.storeId), "settings.json"), b.settings);
        } catch (_) {
          /* ignore */
        }
      }
    }
    saveSettings(appSettings);
    let payload: AppSettings = { ...appSettings };
    if (!isPostgresLive()) {
      try {
        const b = getPosBundle<JsonPosStore>();
        const d = b.settings?.diningEnabled;
        if (typeof d === "boolean") payload = { ...payload, diningEnabled: d };
      } catch (_) {
        /* ignore */
      }
    }
    res.json(payload);
  });

  // Helper: find user by email or phone (phone matched by last 10 digits)
  function findUserByEmailOrPhone(identifier: string): User | undefined {
    users = loadUsers(); // sync file after POST /api/reset-password
    const raw = identifier.trim();
    if (!raw) return undefined;
    const id = raw.toLowerCase();
    const byEmail = users.find((u) => u.email.toLowerCase() === id);
    if (byEmail) return byEmail;
    const byUsername = users.find((u) => u.username && u.username.toLowerCase() === id);
    if (byUsername) return byUsername;
    const digits = raw.replace(/\D/g, "").slice(-10);
    if (digits.length >= 10) {
      const byPhone = users.find((u) => u.phone && u.phone.replace(/\D/g, "").slice(-10) === digits);
      if (byPhone) return byPhone;
    }
    const synUser = normalizeStaffLoginUsername(raw);
    if (synUser) {
      const synEmail = staffSyntheticLoginEmail(synUser);
      return users.find((u) => u.email.toLowerCase() === synEmail);
    }
    return undefined;
  }

  // Auth: register Admin (owner/manager)
  pub.post("/auth/register-admin", async (req: Request, res: Response) => {
    const body = req.body as {
      ownerName?: string;
      storeName?: string;
      businessEmail?: string;
      phone?: string;
      password?: string;
      confirmPassword?: string;
      storeAddress?: string;
      gstNumber?: string;
    };
    const email = (body.businessEmail || "").trim();
    const password = body.password;
    const confirmPassword = body.confirmPassword;
    if (!email || !password) return res.status(400).json({ error: "Business email and password are required" });
    if (password !== confirmPassword) return res.status(400).json({ error: "Passwords do not match" });
    if (password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });
    const existing = users.find((u) => u.email.toLowerCase() === email.toLowerCase());
    if (existing) return res.status(409).json({ error: "An account with this email already exists" });
    const hashed = await hashPassword(password);
    const newUser: User = {
      id: `U${Date.now()}`,
      email,
      password: hashed,
      pin: String(Math.floor(1000 + Math.random() * 9000)),
      role: "admin",
      name: body.ownerName?.trim(),
      phone: body.phone?.trim().replace(/\D/g, "").slice(-10) || undefined,
      storeName: body.storeName?.trim(),
      storeAddress: body.storeAddress?.trim(),
      gstNumber: body.gstNumber?.trim()
    };
    users.push(newUser);
    saveUsers(users);
    const token = signUserJwt(newUser, "7d");
    const storeId = jwtStoreIdForUser(newUser);
    res.status(201).json({ token, user: { id: newUser.id, email: newUser.email, role: newUser.role, storeId } });
  });

  // Auth: register Staff (assigned to a store)
  pub.post("/auth/register-staff", async (req: Request, res: Response) => {
    const body = req.body as {
      staffName?: string;
      staffEmail?: string;
      staffPhone?: string;
      assignedCafe?: string;
      password?: string;
      confirmPassword?: string;
    };
    const email = (body.staffEmail || "").trim();
    const phone = (body.staffPhone || "").replace(/\D/g, "").slice(-10);
    const identifier = email || (phone.length >= 10 ? phone : "");
    if (!identifier) return res.status(400).json({ error: "Staff email or phone is required" });
    const password = body.password;
    const confirmPassword = body.confirmPassword;
    if (!password || password !== confirmPassword) return res.status(400).json({ error: "Passwords do not match" });
    if (password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });
    if (!body.assignedCafe?.trim()) {
      return res.status(400).json({ error: "assignedCafe (hotel / owner user id) is required for staff accounts" });
    }
    const existingByEmail = email ? users.find((u) => u.email.toLowerCase() === email.toLowerCase()) : undefined;
    const existingByPhone = phone ? users.find((u) => u.phone && u.phone.replace(/\D/g, "").endsWith(phone)) : undefined;
    if (existingByEmail || existingByPhone) return res.status(409).json({ error: "An account with this email or phone already exists" });
    const hashed = await hashPassword(password);
    const newUser: User = {
      id: `U${Date.now()}`,
      email: email || `staff-${phone}@pos.local`,
      password: hashed,
      pin: String(Math.floor(1000 + Math.random() * 9000)),
      role: "staff",
      name: body.staffName?.trim(),
      phone: phone || undefined,
      assignedStoreId: body.assignedCafe?.trim()
    };
    users.push(newUser);
    saveUsers(users);
    const token = signUserJwt(newUser, "7d");
    const storeId = jwtStoreIdForUser(newUser);
    res.status(201).json({ token, user: { id: newUser.id, email: newUser.email, role: newUser.role, storeId } });
  });

  // Legacy: single register (creates admin)
  pub.post("/auth/register", async (req: Request, res: Response) => {
    const { email, password } = req.body as { email?: string; password?: string };
    if (!email || !password) return res.status(400).json({ error: "Email and password are required" });
    if (password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });
    const existing = users.find((u) => u.email.toLowerCase() === email.toLowerCase());
    if (existing) return res.status(409).json({ error: "An account with this email already exists" });
    const hashed = await hashPassword(password);
    const newUser: User = {
      id: `U${Date.now()}`,
      email: email.trim(),
      password: hashed,
      pin: String(Math.floor(1000 + Math.random() * 9000)),
      role: "admin"
    };
    users.push(newUser);
    saveUsers(users);
    const token = signUserJwt(newUser, "7d");
    const storeId = jwtStoreIdForUser(newUser);
    res.status(201).json({ token, user: { id: newUser.id, email: newUser.email, role: newUser.role, storeId } });
  });

  /**
   * Seller self-sign-up — requires `SUPER_ADMIN_SIGNUP_SECRET` in server env (share only with you).
   * Unless `SUPER_ADMIN_ALLOW_MULTIPLE=true`, only one `super_admin` may exist (first signup wins).
   */
  pub.post("/auth/register-super-admin", async (req: Request, res: Response) => {
    const body = req.body as {
      email?: string;
      password?: string;
      confirmPassword?: string;
      phone?: string;
      signupSecret?: string;
    };
    const secretEnv = process.env.SUPER_ADMIN_SIGNUP_SECRET?.trim();
    if (!secretEnv) {
      return res.status(503).json({
        error:
          "Seller sign-up is disabled. Set SUPER_ADMIN_SIGNUP_SECRET in the server environment, then restart the backend."
      });
    }
    const signupSecret = typeof body.signupSecret === "string" ? body.signupSecret.trim() : "";
    if (!signupSecret || signupSecret !== secretEnv) {
      return res.status(403).json({ error: "Invalid setup key." });
    }
    const allowMultiple =
      process.env.SUPER_ADMIN_ALLOW_MULTIPLE === "true" || process.env.SUPER_ADMIN_ALLOW_MULTIPLE === "1";
    users = loadUsers();
    if (!allowMultiple && users.some((u) => u.role === "super_admin")) {
      return res.status(403).json({
        error:
          "A platform seller account already exists. Sign in, or set SUPER_ADMIN_ALLOW_MULTIPLE=true on the server to allow another."
      });
    }
    const email = (body.email || "").trim().toLowerCase();
    const password = body.password;
    const confirmPassword = body.confirmPassword;
    if (!email || !password) return res.status(400).json({ error: "Email and password are required" });
    if (password !== confirmPassword) return res.status(400).json({ error: "Passwords do not match" });
    if (password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });
    if (users.some((u) => u.email.toLowerCase() === email)) {
      return res.status(409).json({ error: "An account with this email already exists" });
    }
    const phoneDigits = (body.phone || "").replace(/\D/g, "").slice(-10);
    const phone = phoneDigits.length >= 10 ? phoneDigits : undefined;
    if (phone && users.some((u) => u.phone && u.phone.replace(/\D/g, "").slice(-10) === phone)) {
      return res.status(409).json({ error: "An account with this phone already exists" });
    }
    const hashed = await hashPassword(password);
    const newUser: User = {
      id: process.env.SUPER_ADMIN_USER_ID?.trim() || `SA${Date.now()}`,
      email,
      password: hashed,
      pin: "0000",
      role: "super_admin",
      ...(phone ? { phone } : {})
    };
    users.push(newUser);
    saveUsers(users);
    const token = signUserJwt(newUser, "7d");
    const storeId = jwtStoreIdForUser(newUser);
    res.status(201).json({ token, user: { id: newUser.id, email: newUser.email, role: newUser.role, storeId } });
  });

  // Auth: login with email/phone + password; optional role hint; PIN still supported.
  pub.post("/auth/login", async (req: Request, res: Response) => {
    const { email, phone, password, pin, role: roleHint } = req.body as {
      email?: string;
      phone?: string;
      password?: string;
      pin?: string;
      role?: UserRole;
    };

    let user: User | undefined;
    if (pin) {
      user = users.find((u) => u.pin === pin);
    } else {
      const identifier = (email || phone || "").trim();
      if (!identifier || !password) {
        return res.status(400).json({ error: "Email or phone and password are required" });
      }
      user = findUserByEmailOrPhone(identifier);
      if (!user) {
        return res.status(401).json({ error: "Oops, we don't recognise that account. Check your email or phone." });
      }
      const match = await comparePassword(password, user.password);
      if (!match) {
        return res.status(401).json({ error: "Oops, wrong password. Try again." });
      }
      if (!isBcryptHash(user.password)) {
        user.password = await hashPassword(password);
        saveUsers(users);
      }
    }

    if (!user) {
      return res.status(401).json({ error: "Invalid credentials" });
    }
    /** Café login UI offers admin/staff/manager/chief — seller (`super_admin`) still sends one of those hints. */
    if (roleHint && user.role !== roleHint && user.role !== "super_admin") {
      return res.status(403).json({ error: "This account is registered as " + user.role + ". Use the correct role to sign in." });
    }

    const rawRemember = (req.body as { rememberMe?: unknown }).rememberMe;
    const rememberMe = rawRemember === true || rawRemember === "true" || rawRemember === 1;
    /** Long-lived only when user opts in; shorter token when “Remember me” is off (matches sessionStorage UX). */
    const expiresIn = rememberMe ? "30d" : "1d";
    let storeId: string;
    try {
      storeId = jwtStoreIdForUser(user);
    } catch (e) {
      if (e instanceof Error && e.message === "STAFF_NOT_LINKED") {
        return res.status(403).json({
          error:
            "This staff account is not linked to a hotel. Ask your admin to assign your hotel (store) id to this login.",
          code: "STAFF_NOT_LINKED"
        });
      }
      throw e;
    }
    const token = signUserJwt(user, expiresIn);

    if (process.env.DEBUG_STORE_ID === "1" || process.env.DEBUG_STORE_ID === "true") {
      console.log("[auth/login] storeId=%s user=%s", storeId, JSON.stringify({
        id: user.id,
        email: user.email,
        role: user.role,
        assignedStoreId: user.assignedStoreId
      }));
    }

    res.json({
      token,
      user: { id: user.id, email: user.email, role: user.role, storeId }
    });
  });

  // Forgot password: secure token saved to data/password-reset-tokens.json, reset link emailed (1 h expiry).
  pub.post("/auth/request-reset", async (req: Request, res: Response) => {
    const { email, phone } = req.body as { email?: string; phone?: string };
    const identifier = (email || phone || "").trim();
    if (!identifier) return res.status(400).json({ error: "Email or phone is required" });
    const user = findUserByEmailOrPhone(identifier);
    if (!user) return res.status(404).json({ error: "No account found with this email or phone." });
    const sendTo = user.email;
    if (!isEmailConfigured()) {
      return res.status(500).json({
        error: "Failed to send reset email. Set EMAIL_USER/EMAIL_PASS (or SMTP_*) in backend/.env and restart the backend."
      });
    }
    const rawToken = await resetTokenStore.issueResetToken(sendTo);
    const frontendBase = (process.env.FRONTEND_URL || "http://localhost:3000").replace(/\/$/, "");
    const resetUrl = `${frontendBase}/reset-password?token=${encodeURIComponent(rawToken)}`;
    try {
      await sendPasswordResetLinkEmail(sendTo, resetUrl);
      res.json({ message: "Check your email for a reset link. It expires in 1 hour." });
    } catch (err) {
      console.error("Failed to send reset link email:", err);
      await resetTokenStore.deleteByRawToken(rawToken);
      return res.status(500).json({
        error: "Failed to send reset email. Set EMAIL_USER/EMAIL_PASS (or SMTP_*) in backend/.env and restart the backend."
      });
    }
  });

  // Optional: frontend checks token before showing the form.
  pub.get("/auth/validate-reset-token", async (req: Request, res: Response) => {
    const token = typeof req.query.token === "string" ? req.query.token : "";
    const row = await resetTokenStore.findValidByRawToken(token);
    if (!row) {
      return res.status(400).json({ valid: false, error: "Invalid or expired reset link." });
    }
    res.json({ valid: true });
  });

  // Reset password using token from email link; token deleted after success.
  pub.post("/auth/reset-password", async (req: Request, res: Response) => {
    const { token, newPassword } = req.body as { token?: string; newPassword?: string };
    const rawToken = typeof token === "string" ? token.trim() : "";
    if (!rawToken || !newPassword) {
      return res.status(400).json({ error: "Token and new password are required" });
    }
    const row = await resetTokenStore.findValidByRawToken(rawToken);
    if (!row) {
      return res.status(400).json({ error: "Invalid or expired reset link. Request a new one." });
    }
    if (newPassword.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });
    users = loadUsers();
    const user = users.find((u) => u.email.toLowerCase() === row.email);
    if (!user) {
      await resetTokenStore.deleteByRawToken(rawToken);
      return res.status(404).json({ error: "Account no longer exists." });
    }
    user.password = await hashPassword(newPassword);
    await resetTokenStore.deleteByRawToken(rawToken);
    saveUsers(users);
    await updateUserPasswordMysql(user.email, newPassword);
    try {
      await sendPasswordChangedEmail(user.email);
    } catch (_) {
      // Password was updated; email is best-effort
    }
    res.json({ message: "Password updated successfully" });
  });

  // Floor sections (dining areas)
  prot.get("/sections", (_req: Request, res: Response) => {
    res.json(menuFloorPlan().sections);
  });

  prot.post("/sections", (req: Request, res: Response) => {
    const name = String((req.body as { name?: string }).name ?? "").trim();
    if (!name) return res.status(400).json({ error: "name is required" });
    const plan = menuFloorPlan();
    const id = newSectionId();
    plan.sections.push({ id, name });
    flushFloorPlanToDisk();
    res.status(201).json({ id, name });
  });

  prot.patch("/sections/:id", (req: Request, res: Response) => {
    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ error: "id required" });
    const name = String((req.body as { name?: string }).name ?? "").trim();
    if (!name) return res.status(400).json({ error: "name is required" });
    const plan = menuFloorPlan();
    const s = plan.sections.find((x) => x.id === id);
    if (!s) return res.status(404).json({ error: "Section not found" });
    s.name = name;
    flushFloorPlanToDisk();
    res.json({ id, name });
  });

  prot.delete("/sections/:id", (req: Request, res: Response) => {
    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ error: "id required" });
    const plan = menuFloorPlan();
    const idx = plan.sections.findIndex((s) => s.id === id);
    if (idx < 0) return res.status(404).json({ error: "Section not found" });
    plan.sections.splice(idx, 1);
    plan.tables = plan.tables.filter((t) => t.sectionId !== id);
    if (plan.sections.length === 0) {
      plan.sections.push({ id: DEFAULT_MAIN_SECTION_ID, name: DEFAULT_MAIN_SECTION_NAME });
    }
    flushFloorPlanToDisk();
    res.json({ ok: true });
  });

  // Tables
  prot.get("/tables", (_req: Request, res: Response) => {
    res.json(menuTables());
  });

  prot.post("/tables", (req: Request, res: Response) => {
    const body = req.body as { id?: string; name?: string; sectionId?: string };
    const sectionId = String(body.sectionId ?? "").trim();
    if (!sectionId) return res.status(400).json({ error: "sectionId is required" });
    const plan = menuFloorPlan();
    if (!plan.sections.some((s) => s.id === sectionId)) {
      return res.status(400).json({ error: "Unknown sectionId" });
    }
    let tid = typeof body.id === "string" ? body.id.trim() : "";
    let tname = typeof body.name === "string" ? body.name.trim() : "";
    const list = plan.tables;
    if (!tid || !tname) {
      let maxN = 0;
      for (const t of list) {
        const m = /^T(\d+)$/i.exec(t.id);
        if (m) maxN = Math.max(maxN, parseInt(m[1], 10));
        const m2 = /^Table\s+(\d+)$/i.exec(t.name);
        if (m2) maxN = Math.max(maxN, parseInt(m2[1], 10));
      }
      const n = maxN + 1;
      tid = tid || `T${n}`;
      tname = tname || `Table ${n}`;
    }
    if (list.some((t) => t.id === tid)) {
      return res.status(409).json({ error: "A table with this id already exists" });
    }
    const row: FloorTable = { id: tid, name: tname, sectionId };
    list.push(row);
    flushFloorPlanToDisk();
    res.status(201).json(row);
  });

  prot.post("/tables/bulk", (req: Request, res: Response) => {
    const body = req.body as { sectionId?: string; from?: unknown; count?: unknown };
    const sectionId = String(body.sectionId ?? "").trim();
    if (!sectionId) return res.status(400).json({ error: "sectionId is required" });
    const plan = menuFloorPlan();
    if (!plan.sections.some((s) => s.id === sectionId)) {
      return res.status(400).json({ error: "Unknown sectionId" });
    }
    let from = Math.floor(Number(body.from));
    if (!Number.isFinite(from) || from < 1) from = 1;
    let count = Math.floor(Number(body.count));
    if (!Number.isFinite(count) || count < 1) count = 1;
    count = Math.min(100, count);
    const to = from + count - 1;
    if (to - from > 99) {
      return res.status(400).json({ error: "Maximum 100 tables per request" });
    }
    const list = plan.tables;
    const existingIds = new Set(list.map((t) => t.id));
    const newRows: FloorTable[] = [];
    for (let n = from; n <= to; n++) {
      const id = `T${n}`;
      if (existingIds.has(id)) continue;
      existingIds.add(id);
      newRows.push({ id, name: `Table ${n}`, sectionId });
    }
    if (!newRows.length) {
      return res.status(409).json({ error: "All table numbers in this range already exist" });
    }
    for (const t of newRows) list.push(t);
    flushFloorPlanToDisk();
    res.status(201).json({ added: newRows.length, tables: newRows });
  });

  // Waiter Calls (customer at table requests waiter)
  type WaiterCall = { id: string; tableId: string; createdAt: string; dismissed: boolean };
  const WAITER_CALLS_FILE = path.join(DATA_DIR, "waiter-calls.json");
  function loadWaiterCalls(): WaiterCall[] {
    try {
      const data = fs.readFileSync(WAITER_CALLS_FILE, "utf-8");
      const arr = JSON.parse(data);
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }
  function saveWaiterCalls(list: WaiterCall[]) {
    setImmediate(() => {
      try {
        fs.mkdirSync(path.dirname(WAITER_CALLS_FILE), { recursive: true });
        writeJsonValueAtomicSync(WAITER_CALLS_FILE, list);
      } catch (err) {
        console.error("Failed to save waiter calls:", err);
      }
    });
  }
  let waiterCalls: WaiterCall[] = loadWaiterCalls();

  prot.get("/waiter-calls", (_req: Request, res: Response) => {
    waiterCalls = loadWaiterCalls();
    const active = waiterCalls.filter((c) => !c.dismissed);
    res.json(active.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()));
  });
  pub.post("/waiter-calls", (req: Request, res: Response) => {
    const { tableId } = req.body as { tableId?: string };
    if (!tableId) return res.status(400).json({ error: "tableId required" });
    const table = menuTables().find((t) => t.id === tableId);
    if (!table) return res.status(400).json({ error: "Invalid tableId" });
    const call: WaiterCall = {
      id: `WC${Date.now()}`,
      tableId,
      createdAt: new Date().toISOString(),
      dismissed: false
    };
    waiterCalls.push(call);
    saveWaiterCalls(waiterCalls);
    res.status(201).json(call);
  });
  prot.patch("/waiter-calls/:id/dismiss", (req: Request, res: Response) => {
    const c = waiterCalls.find((x) => x.id === req.params.id);
    if (!c) return res.status(404).json({ error: "Call not found" });
    c.dismissed = true;
    saveWaiterCalls(waiterCalls);
    res.json(c);
  });

  // Guest table help requests (QR: waiter, water, bill) — persisted for waiter panel
  type GuestTableRequestKind = "CALL_WAITER" | "NEED_WATER" | "REQUEST_BILL";
  type GuestTableRequest = {
    id: string;
    kind: GuestTableRequestKind;
    tableId: string;
    tableLabel: string;
    /** Missing on legacy rows — treat as default store. */
    storeId?: string;
    customerName?: string;
    customerPhone?: string;
    status: "OPEN" | "DONE";
    createdAt: string;
  };
  const GUEST_REQUESTS_FILE = path.join(DATA_DIR, "guest-table-requests.json");
  function loadGuestTableRequests(): GuestTableRequest[] {
    try {
      const data = fs.readFileSync(GUEST_REQUESTS_FILE, "utf-8");
      const arr = JSON.parse(data) as unknown;
      if (!Array.isArray(arr)) return [];
      return arr.filter((row) => row && typeof row === "object") as GuestTableRequest[];
    } catch {
      return [];
    }
  }
  function saveGuestTableRequests(list: GuestTableRequest[]) {
    setImmediate(() => {
      try {
        fs.mkdirSync(path.dirname(GUEST_REQUESTS_FILE), { recursive: true });
        writeJsonValueAtomicSync(GUEST_REQUESTS_FILE, list);
      } catch (err) {
        console.error("Failed to save guest table requests:", err);
      }
    });
  }
  let guestTableRequests: GuestTableRequest[] = loadGuestTableRequests();

  function guestRequestKindFromBody(t: unknown): GuestTableRequestKind | null {
    const u = String(t || "")
      .toUpperCase()
      .replace(/\s+/g, "_");
    if (u === "CALL_WAITER" || u === "CALLWAITER") return "CALL_WAITER";
    if (u === "NEED_WATER" || u === "WATER") return "NEED_WATER";
    if (u === "REQUEST_BILL" || u === "BILL") return "REQUEST_BILL";
    return null;
  }

  pub.post("/requests", (req: Request, res: Response) => {
    const body = req.body as Record<string, unknown>;
    const kind = guestRequestKindFromBody(body.type ?? body.kind);
    const tableRaw =
      typeof body.table === "string" && body.table.trim()
        ? body.table.trim()
        : typeof body.tableId === "string"
          ? body.tableId.trim()
          : "";
    if (!kind) {
      return res
        .status(400)
        .json({ error: "type must be CALL_WAITER, NEED_WATER, or REQUEST_BILL" });
    }
    if (!tableRaw) {
      return res.status(400).json({ error: "table is required" });
    }
    const floor = menuFloorPlan();
    const resolved = resolveTableIdFromQrParam(tableRaw, floor.tables);
    if (!resolved) {
      return res.status(400).json({ error: "Unknown table" });
    }
    const tableRow = floor.tables.find((x) => x.id === resolved);
    let storeId = LEGACY_DEFAULT_STORE_ID;
    try {
      storeId = getPosScope().storeId;
    } catch {
      /* no tenant */
    }
    const bodyStore = typeof body.storeId === "string" ? body.storeId.trim() : "";
    if (bodyStore) storeId = sanitizeStoreId(bodyStore);

    const customerName =
      typeof body.customerName === "string" && body.customerName.trim()
        ? body.customerName.trim()
        : undefined;
    const customerPhone =
      typeof body.phone === "string" && body.phone.trim()
        ? body.phone.trim()
        : typeof body.customerPhone === "string" && body.customerPhone.trim()
          ? body.customerPhone.trim()
          : undefined;

    const rec: GuestTableRequest = {
      id: `GR${Date.now()}-${crypto.randomBytes(3).toString("hex")}`,
      kind,
      tableId: resolved,
      tableLabel: tableRow?.name?.trim() || tableRaw,
      storeId,
      customerName,
      customerPhone,
      status: "OPEN",
      createdAt: new Date().toISOString()
    };
    guestTableRequests = loadGuestTableRequests();
    guestTableRequests.push(rec);
    saveGuestTableRequests(guestTableRequests);
    res.status(201).json(rec);
  });

  pub.patch(
    "/customer/orders/:orderId/guest-upi-claim",
    guestClaimLimiter,
    (req: Request, res: Response) => {
      try {
        const orderId = (req.params.orderId || "").trim();
        if (!orderId) return res.status(400).json({ error: "orderId required" });
        const order = orders.find((o) => o.id === orderId);
        if (!order) return res.status(404).json({ error: "Order not found" });
        if (order.guestPaymentStatus !== "UPI_PENDING") {
          return res.status(400).json({ error: "Order is not awaiting UPI payer confirmation" });
        }
        order.guestPaymentStatus = "PAYMENT_PENDING_VERIFICATION";
        persistOrdersOnly();
        res.json({
          id: order.id,
          guestPaymentStatus: order.guestPaymentStatus
        });
      } catch (e) {
        console.error("[guest-upi-claim]", e);
        res.status(500).json({ error: "Server error" });
      }
    }
  );

  prot.get("/requests", (_req: Request, res: Response) => {
    guestTableRequests = loadGuestTableRequests();
    let sid = LEGACY_DEFAULT_STORE_ID;
    try {
      sid = getPosScope().storeId;
    } catch {
      /* */
    }
    const open = guestTableRequests
      .filter((r) => r.status === "OPEN" && (!r.storeId || r.storeId === sid))
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    res.json(open);
  });

  prot.patch("/requests/:id", (req: Request, res: Response) => {
    const st = String((req.body as { status?: string }).status || "").toUpperCase();
    if (st !== "DONE") {
      return res.status(400).json({ error: "body.status must be DONE" });
    }
    guestTableRequests = loadGuestTableRequests();
    const r = guestTableRequests.find((x) => x.id === req.params.id);
    if (!r) return res.status(404).json({ error: "Request not found" });
    let sid = LEGACY_DEFAULT_STORE_ID;
    try {
      sid = getPosScope().storeId;
    } catch {
      /* */
    }
    if (r.storeId && r.storeId !== sid) {
      return res.status(404).json({ error: "Request not found" });
    }
    r.status = "DONE";
    saveGuestTableRequests(guestTableRequests);
    res.json(r);
  });

  prot.get("/payments/guest-upi-pending", (_req: Request, res: Response) => {
    try {
      let sid = LEGACY_DEFAULT_STORE_ID;
      try {
        sid = getPosScope().storeId;
      } catch {
        /* */
      }
      const pending = orders.filter(
        (o) =>
          (o.storeId || LEGACY_DEFAULT_STORE_ID) === sid &&
          o.guestPaymentStatus === "PAYMENT_PENDING_VERIFICATION"
      );
      res.json(
        pending
          .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
          .map((o) => ({
            id: o.id,
            tableId: o.tableId,
            tableName: tableLabelForGuestBill(o),
            customerName: o.customerName,
            customerMobile: o.customerMobile,
            total: calculateTotal(o.items),
            createdAt: o.createdAt,
            itemCount: o.items.reduce((s, i) => s + i.qty, 0)
          }))
      );
    } catch (e) {
      console.error("[guest-upi-pending]", e);
      res.status(500).json({ error: "Server error" });
    }
  });

  prot.patch("/orders/:orderId/guest-upi-verify", (req: Request, res: Response) => {
    try {
      const { decision } = req.body as { decision?: string };
      const d = String(decision || "").toUpperCase();
      if (d !== "PAID" && d !== "FAILED") {
        return res.status(400).json({ error: "decision must be PAID or FAILED" });
      }
      const order = orders.find((o) => o.id === req.params.orderId);
      if (!order) return res.status(404).json({ error: "Order not found" });
      let sid = LEGACY_DEFAULT_STORE_ID;
      try {
        sid = getPosScope().storeId;
      } catch {
        /* */
      }
      if ((order.storeId || LEGACY_DEFAULT_STORE_ID) !== sid) {
        return res.status(404).json({ error: "Order not found" });
      }
      if (order.guestPaymentStatus !== "PAYMENT_PENDING_VERIFICATION") {
        return res.status(400).json({ error: "Order is not awaiting payment verification" });
      }
      if (d === "FAILED") {
        order.guestPaymentStatus = "PAYMENT_FAILED";
        persistOrdersOnly();
        return res.json({ id: order.id, guestPaymentStatus: order.guestPaymentStatus });
      }
      order.guestPaymentStatus = "PAID";
      order.isPaid = true;
      touchOrders("guest_upi_verified");
      res.json({ id: order.id, guestPaymentStatus: order.guestPaymentStatus });
    } catch (e) {
      console.error("[guest-upi-verify]", e);
      res.status(500).json({ error: "Server error" });
    }
  });

  prot.get("/bills", (_req: Request, res: Response) => {
    try {
      let sid = LEGACY_DEFAULT_STORE_ID;
      try {
        sid = getPosScope().storeId;
      } catch {
        /* */
      }
      res.json(listBillsForStore(sid, 300));
    } catch (e) {
      console.error("[bills list]", e);
      res.status(500).json({ error: "Server error" });
    }
  });

  prot.get("/bills/:id", (req: Request, res: Response) => {
    try {
      let sid = LEGACY_DEFAULT_STORE_ID;
      try {
        sid = getPosScope().storeId;
      } catch {
        /* */
      }
      const b = getBillById(req.params.id, sid);
      if (!b) return res.status(404).json({ error: "Bill not found" });
      res.json(b);
    } catch (e) {
      console.error("[bill]", e);
      res.status(500).json({ error: "Server error" });
    }
  });

  prot.get("/analytics", (req: Request, res: Response) => {
    try {
      const q = typeof req.query.range === "string" ? req.query.range.toLowerCase() : "today";
      const range: "today" | "week" | "month" =
        q === "week" ? "week" : q === "month" ? "month" : "today";
      let sid = LEGACY_DEFAULT_STORE_ID;
      try {
        sid = getPosScope().storeId;
      } catch {
        /* */
      }
      const startMs = analyticsRangeStartMs(range);
      const list = orders.filter((o) => (o.storeId || LEGACY_DEFAULT_STORE_ID) === sid);
      const inRange = list.filter((o) => new Date(o.createdAt).getTime() >= startMs);
      const nonCancelled = inRange.filter((o) => o.status !== "cancelled");
      const completedOrPaid = nonCancelled.filter((o) => o.isPaid || o.status === "completed");
      const orderCount = completedOrPaid.length;
      const revenue = completedOrPaid.reduce((s, o) => s + calculateTotal(o.items), 0);
      const avgOrderValue = orderCount > 0 ? Math.round((revenue / orderCount) * 100) / 100 : 0;

      const itemAgg = new Map<string, number>();
      for (const o of completedOrPaid) {
        for (const it of o.items) {
          itemAgg.set(it.name, (itemAgg.get(it.name) ?? 0) + it.qty);
        }
      }
      const topItems = [...itemAgg.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([name, qty]) => ({ name, qty }));

      const hourly = Array.from({ length: 24 }, (_, h) => ({ hour: h, orders: 0 }));
      for (const o of completedOrPaid) {
        const hour = new Date(o.createdAt).getHours();
        hourly[hour].orders += 1;
      }

      const tableAgg = new Map<string, number>();
      for (const o of completedOrPaid) {
        const label = tableLabelForGuestBill(o);
        tableAgg.set(label, (tableAgg.get(label) ?? 0) + 1);
      }
      const tablePerformance = [...tableAgg.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([table, oc]) => ({ table, orders: oc }));

      res.json({
        range,
        totalOrders: orderCount,
        totalRevenue: Math.round(revenue * 100) / 100,
        avgOrderValue,
        topItems,
        hourlyOrders: hourly,
        tablePerformance
      });
    } catch (e) {
      console.error("[analytics]", e);
      res.status(500).json({ error: "Server error" });
    }
  });

  /** QR menu: validate table id for current tenant (JSON: ?storeId= or X-Store-Id). */
  pub.get("/customer/table/:tableId", (req: Request, res: Response) => {
    const id = (req.params.tableId || "").trim();
    if (!id) return res.status(400).json({ error: "tableId required" });
    try {
      if (!getStoreFeaturesForStore(getPosScope().storeId).qrOrdering) {
        return res.status(403).json({ message: "Feature disabled", code: "FEATURE_DISABLED", feature: "qrOrdering" });
      }
    } catch {
      return res.status(503).json({ error: "Store context unavailable" });
    }
    const floor = menuFloorPlan();
    let t = floor.tables.find((x) => x.id === id);
    if (!t) {
      const resolved = resolveTableIdFromQrParam(id, floor.tables);
      if (resolved) t = floor.tables.find((x) => x.id === resolved);
    }
    if (!t) return res.status(404).json({ error: "Unknown table" });
    const sectionName = sectionNameById(floor, t.sectionId);
    res.json({ id: t.id, name: t.name, sectionId: t.sectionId, sectionName });
  });

  // Staff Management (employees, shifts, salary)
  type StaffMember = {
    id: string;
    name: string;
    phone: string;
    role: string;
    salary: number;
    hireDate?: string;
    createdAt: string;
  };
  type StaffShift = {
    id: string;
    staffId: string;
    date: string;
    startTime: string;
    endTime: string;
    role?: string;
  };
  const STAFF_FILE = path.join(DATA_DIR, "staff.json");
  const SHIFTS_FILE = path.join(DATA_DIR, "shifts.json");
  const ROLES = ["Waiter", "Cashier", "Chef", "Kitchen", "Manager", "Other"];

  function loadStaff(): StaffMember[] {
    try {
      const data = fs.readFileSync(STAFF_FILE, "utf-8");
      const arr = JSON.parse(data);
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }
  function saveStaff(list: StaffMember[]) {
    setImmediate(() => {
      try {
        fs.mkdirSync(path.dirname(STAFF_FILE), { recursive: true });
        writeJsonValueAtomicSync(STAFF_FILE, list);
      } catch (err) {
        console.error("Failed to save staff:", err);
      }
    });
  }
  function loadShifts(): StaffShift[] {
    try {
      const data = fs.readFileSync(SHIFTS_FILE, "utf-8");
      const arr = JSON.parse(data);
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }
  function saveShifts(list: StaffShift[]) {
    setImmediate(() => {
      try {
        fs.mkdirSync(path.dirname(SHIFTS_FILE), { recursive: true });
        writeJsonValueAtomicSync(SHIFTS_FILE, list);
      } catch (err) {
        console.error("Failed to save shifts:", err);
      }
    });
  }
  let staffList: StaffMember[] = loadStaff();
  let shiftsList: StaffShift[] = loadShifts();

  registerStaffListReload(() => {
    staffList = loadStaff();
  });

  function enrichStaffWithLogin(list: StaffMember[]) {
    users = loadUsers();
    const domainSuffix = `@${STAFF_LOGIN_EMAIL_DOMAIN}`.toLowerCase();
    return list.map((s) => {
      const u = users.find((x) => x.staffMemberId === s.id);
      let loginUsername: string | null = null;
      if (u && u.email.toLowerCase().endsWith(domainSuffix)) {
        loginUsername = u.email.slice(0, -domainSuffix.length);
      }
      return { ...s, loginUsername };
    });
  }

  prot.get("/staff", (_req: Request, res: Response) => {
    staffList = loadStaff();
    res.json(enrichStaffWithLogin(staffList));
  });
  prot.post("/staff", async (req: Request, res: Response) => {
    const {
      name,
      phone,
      role,
      salary,
      hireDate,
      username: usernameRaw,
      password,
      confirmPassword
    } = req.body as {
      name?: string;
      phone?: string;
      role?: string;
      salary?: number;
      hireDate?: string;
      username?: string;
      password?: string;
      confirmPassword?: string;
    };
    if (!name || !phone) return res.status(400).json({ error: "Name and phone required" });
    const username = usernameRaw ? normalizeStaffLoginUsername(String(usernameRaw)) : null;
    if (!username) {
      return res
        .status(400)
        .json({ error: "Username must be 3–32 characters (letters, numbers, underscores, hyphens only)" });
    }
    const pwd = typeof password === "string" ? password : "";
    const pwd2 = typeof confirmPassword === "string" ? confirmPassword : pwd;
    if (pwd.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });
    if (pwd !== pwd2) return res.status(400).json({ error: "Passwords do not match" });

    staffList = loadStaff();
    users = loadUsers();
    const synEmail = staffSyntheticLoginEmail(username);
    if (users.some((u) => u.email.toLowerCase() === synEmail)) {
      return res.status(409).json({ error: "This username is already taken" });
    }

    const s: StaffMember = {
      id: `ST${staffList.length + 1}${String(Date.now()).slice(-4)}`,
      name: String(name).trim(),
      phone: String(phone).trim(),
      role: role && ROLES.includes(role) ? role : "Other",
      salary: Math.max(0, Number(salary) || 0),
      hireDate: hireDate || undefined,
      createdAt: new Date().toISOString()
    };

    const hashed = await hashPassword(pwd);
    const digits = s.phone.replace(/\D/g, "").slice(-10);
    const tenantStoreId = req.user!.storeId;
    const newUser: User = {
      id: `U${Date.now()}`,
      email: synEmail,
      password: hashed,
      pin: String(Math.floor(1000 + Math.random() * 9000)),
      role: "staff",
      name: s.name,
      phone: digits.length >= 10 ? digits : undefined,
      staffMemberId: s.id,
      assignedStoreId: tenantStoreId
    };

    staffList.push(s);
    users.push(newUser);
    saveStaff(staffList);
    saveUsers(users);
    res.status(201).json({ ...s, loginUsername: username });
  });
  prot.patch("/staff/:id", (req: Request, res: Response) => {
    const s = staffList.find((x) => x.id === req.params.id);
    if (!s) return res.status(404).json({ error: "Staff not found" });
    const { name, phone, role, salary, hireDate } = req.body as Partial<StaffMember>;
    if (name !== undefined) s.name = String(name).trim();
    if (phone !== undefined) s.phone = String(phone).trim();
    if (role !== undefined && ROLES.includes(role)) s.role = role;
    if (salary !== undefined) s.salary = Math.max(0, Number(salary));
    if (hireDate !== undefined) s.hireDate = hireDate || undefined;
    saveStaff(staffList);
    res.json(s);
  });
  prot.delete("/staff/:id", (req: Request, res: Response) => {
    staffList = loadStaff();
    const idx = staffList.findIndex((x) => x.id === req.params.id);
    if (idx < 0) return res.status(404).json({ error: "Staff not found" });
    staffList.splice(idx, 1);
    saveStaff(staffList);
    users = loadUsers();
    const uIdx = users.findIndex((u) => u.staffMemberId === req.params.id);
    if (uIdx >= 0) {
      users.splice(uIdx, 1);
      saveUsers(users);
    }
    res.json({ ok: true });
  });
  prot.get("/staff/roles", (_req: Request, res: Response) => res.json(ROLES));

  prot.get("/shifts", (req: Request, res: Response) => {
    const date = (req.query.date as string) || new Date().toISOString().slice(0, 10);
    shiftsList = loadShifts();
    const list = shiftsList.filter((s) => s.date === date);
    res.json(list);
  });
  prot.get("/shifts/all", (_req: Request, res: Response) => {
    shiftsList = loadShifts();
    res.json(shiftsList.slice(-200).reverse());
  });
  prot.post("/shifts", (req: Request, res: Response) => {
    const { staffId, date, startTime, endTime, role } = req.body as Partial<StaffShift>;
    if (!staffId || !date || !startTime || !endTime) return res.status(400).json({ error: "staffId, date, startTime, endTime required" });
    const staff = staffList.find((s) => s.id === staffId);
    if (!staff) return res.status(400).json({ error: "Invalid staffId" });
    const sh: StaffShift = {
      id: `SH${Date.now()}`,
      staffId,
      date,
      startTime,
      endTime,
      role: role || staff.role
    };
    shiftsList.push(sh);
    saveShifts(shiftsList);
    res.status(201).json(sh);
  });
  prot.delete("/shifts/:id", (req: Request, res: Response) => {
    const idx = shiftsList.findIndex((x) => x.id === req.params.id);
    if (idx < 0) return res.status(404).json({ error: "Shift not found" });
    shiftsList.splice(idx, 1);
    saveShifts(shiftsList);
    res.json({ ok: true });
  });
  prot.get("/staff/salary-report", (_req: Request, res: Response) => {
    staffList = loadStaff();
    const enriched = enrichStaffWithLogin(staffList);
    const total = enriched.reduce((acc, e) => acc + e.salary, 0);
    res.json({ staff: enriched, totalSalary: total, count: enriched.length });
  });

  type AttendanceRecord = {
    id: string;
    staffId: string;
    date: string;
    checkInAt: string;
    checkOutAt?: string;
  };
  const ATTENDANCE_FILE = path.join(DATA_DIR, "attendance.json");
  function loadAttendance(): AttendanceRecord[] {
    try {
      const data = fs.readFileSync(ATTENDANCE_FILE, "utf-8");
      const arr = JSON.parse(data);
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }
  function saveAttendance(list: AttendanceRecord[]) {
    setImmediate(() => {
      try {
        fs.mkdirSync(path.dirname(ATTENDANCE_FILE), { recursive: true });
        writeJsonValueAtomicSync(ATTENDANCE_FILE, list);
      } catch (err) {
        console.error("Failed to save attendance:", err);
      }
    });
  }
  let attendanceList: AttendanceRecord[] = loadAttendance();

  prot.get("/attendance", (req: Request, res: Response) => {
    const date = req.query.date as string | undefined;
    const staffId = req.query.staffId as string | undefined;
    const from = req.query.from as string | undefined;
    const to = req.query.to as string | undefined;
    attendanceList = loadAttendance();
    let list = attendanceList;
    if (date) list = list.filter((a) => a.date === date);
    if (staffId) list = list.filter((a) => a.staffId === staffId);
    if (from) list = list.filter((a) => a.date >= from);
    if (to) list = list.filter((a) => a.date <= to);
    res.json(list.slice(-200).reverse());
  });
  prot.post("/attendance/check-in", (req: Request, res: Response) => {
    const { staffId } = req.body as { staffId?: string };
    if (!staffId) return res.status(400).json({ error: "staffId required" });
    const staff = staffList.find((s) => s.id === staffId);
    if (!staff) return res.status(400).json({ error: "Staff not found" });
    const dateStr = new Date().toISOString().slice(0, 10);
    const existing = attendanceList.find((a) => a.staffId === staffId && a.date === dateStr && !a.checkOutAt);
    if (existing) return res.status(400).json({ error: "Already checked in today", record: existing });
    const rec: AttendanceRecord = {
      id: `AT${Date.now()}`,
      staffId,
      date: dateStr,
      checkInAt: new Date().toISOString()
    };
    attendanceList.push(rec);
    saveAttendance(attendanceList);
    res.status(201).json(rec);
  });
  prot.post("/attendance/check-out", (req: Request, res: Response) => {
    const { staffId } = req.body as { staffId?: string };
    if (!staffId) return res.status(400).json({ error: "staffId required" });
    const dateStr = new Date().toISOString().slice(0, 10);
    const rec = attendanceList.find((a) => a.staffId === staffId && a.date === dateStr && !a.checkOutAt);
    if (!rec) return res.status(404).json({ error: "No open check-in found for today" });
    rec.checkOutAt = new Date().toISOString();
    saveAttendance(attendanceList);
    res.json(rec);
  });

  prot.get("/staff/performance", (req: Request, res: Response) => {
    const from = (req.query.from as string) || new Date().toISOString().slice(0, 10);
    const to = (req.query.to as string) || new Date().toISOString().slice(0, 10);
    staffList = loadStaff();
    const byStaff: Record<string, { staffId: string; name: string; role: string; orderCount: number; totalSales: number }> = {};
    staffList.forEach((s) => {
      byStaff[s.id] = { staffId: s.id, name: s.name, role: s.role, orderCount: 0, totalSales: 0 };
    });
    payments.forEach((p) => {
      if (!p.staffId) return;
      const d = (p.createdAt || "").slice(0, 10);
      if (d < from || d > to) return;
      const row = byStaff[p.staffId];
      if (row) {
        row.orderCount += 1;
        row.totalSales += p.amount;
      }
    });
    const list = Object.values(byStaff).filter((r) => r.orderCount > 0).sort((a, b) => b.totalSales - a.totalSales);
    res.json({ from, to, performance: list });
  });

  // Table Reservations
  type Reservation = {
    id: string;
    tableId: string;
    date: string;
    time: string;
    guestName: string;
    guestPhone: string;
    guests: number;
    status: "pending" | "confirmed" | "seated" | "cancelled" | "no_show";
    note?: string;
    createdAt: string;
  };
  const RESERVATIONS_FILE = path.join(DATA_DIR, "reservations.json");
  function loadReservations(): Reservation[] {
    try {
      const data = fs.readFileSync(RESERVATIONS_FILE, "utf-8");
      const arr = JSON.parse(data);
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }
  function saveReservations(list: Reservation[]) {
    setImmediate(() => {
      try {
        fs.mkdirSync(path.dirname(RESERVATIONS_FILE), { recursive: true });
        writeJsonValueAtomicSync(RESERVATIONS_FILE, list);
      } catch (err) {
        console.error("Failed to save reservations:", err);
      }
    });
  }
  let reservations: Reservation[] = loadReservations();

  prot.get("/reservations", (req: Request, res: Response) => {
    const date = (req.query.date as string) || new Date().toISOString().slice(0, 10);
    const list = reservations.filter((r) => r.date === date && r.status !== "cancelled" && r.status !== "no_show");
    res.json(list.sort((a, b) => a.time.localeCompare(b.time)));
  });
  prot.get("/reservations/all", (_req: Request, res: Response) => {
    res.json(reservations.slice(-100).reverse());
  });
  prot.post("/reservations", (req: Request, res: Response) => {
    const { tableId, date, time, guestName, guestPhone, guests, note } = req.body as Partial<Reservation>;
    if (!tableId || !date || !time || !guestName || !guestPhone) {
      return res.status(400).json({ error: "tableId, date, time, guestName, guestPhone required" });
    }
    const table = menuTables().find((t) => t.id === tableId);
    if (!table) return res.status(400).json({ error: "Invalid tableId" });
    const r: Reservation = {
      id: `RV${reservations.length + 1}${String(Date.now()).slice(-4)}`,
      tableId,
      date,
      time,
      guestName: String(guestName).trim(),
      guestPhone: String(guestPhone).trim(),
      guests: Math.max(1, Math.min(20, Number(guests) || 2)),
      status: "pending",
      note: note ? String(note).trim() : undefined,
      createdAt: new Date().toISOString()
    };
    reservations.push(r);
    saveReservations(reservations);
    res.status(201).json(r);
  });
  prot.patch("/reservations/:id", (req: Request, res: Response) => {
    const id = req.params.id;
    const { status } = req.body as { status?: Reservation["status"] };
    const r = reservations.find((x) => x.id === id);
    if (!r) return res.status(404).json({ error: "Reservation not found" });
    if (status && ["pending", "confirmed", "seated", "cancelled", "no_show"].includes(status)) {
      r.status = status;
      saveReservations(reservations);
    }
    res.json(r);
  });

  type TableStatus = "blank" | "running" | "printed" | "paid" | "running_kot";

  /** Local calendar YYYY-MM-DD for matching reservation `date` strings. */
  function localDateYmd(d = new Date()): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  prot.get("/tables/view", (_req: Request, res: Response) => {
    staffList = loadStaff();
    reservations = loadReservations();
    const todayYmd = localDateYmd();
    const reservationsForToday = reservations.filter(
      (r) =>
        r.date === todayYmd &&
        r.status !== "cancelled" &&
        r.status !== "no_show"
    );
    const reservationsByTableId = new Map<
      string,
      { id: string; time: string; guestName: string; guests: number; status: Reservation["status"] }[]
    >();
    for (const r of reservationsForToday) {
      const row = {
        id: r.id,
        time: r.time,
        guestName: r.guestName,
        guests: r.guests,
        status: r.status
      };
      const list = reservationsByTableId.get(r.tableId) ?? [];
      list.push(row);
      reservationsByTableId.set(r.tableId, list);
    }
    for (const [, list] of reservationsByTableId) {
      list.sort((a, b) => a.time.localeCompare(b.time));
    }
    const waiterForOrder = (o: Order): { waiterId?: string; waiterName?: string } => {
      const waiterId = typeof o.waiterId === "string" && o.waiterId.trim() ? o.waiterId.trim() : undefined;
      let waiterName =
        typeof o.waiterName === "string" && o.waiterName.trim() ? o.waiterName.trim() : undefined;
      if (waiterId) {
        const s = staffList.find((e) => e.id === waiterId);
        if (s?.name) waiterName = s.name;
      }
      return { waiterId, waiterName };
    };
    /** Live / waiter lobby: paid or closed tickets do not hold the table — show as available (blank). */
    const latestOpenOrderForTable = (tableId: string): Order | undefined => {
      const open = orders.filter(
        (o) =>
          o.tableId === tableId &&
          orderVisibleOnKitchenBoard(o) &&
          !o.isPaid &&
          o.status !== "completed" &&
          o.status !== "cancelled"
      );
      if (!open.length) return undefined;
      return open.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
    };
    const plan = menuFloorPlan();
    const tableStatuses = plan.tables.map((t) => {
      const order = latestOpenOrderForTable(t.id);
      let status: TableStatus = "blank";
      let elapsedMinutes = 0;
      let itemCount = 0;
      let total = 0;
      let waiterId: string | undefined;
      let waiterName: string | undefined;
      if (order) {
        if (order.status === "new" || order.status === "cooking") status = "running_kot";
        else if (order.status === "ready" || order.status === "served") status = "printed";
        else status = "printed";
        const ms = Date.now() - new Date(order.createdAt).getTime();
        elapsedMinutes = Math.floor(ms / 60000);
        itemCount = order.items.reduce((s, i) => s + (i.qty || 1), 0);
        total = orderInvoiceGrandTotal(order);
        const w = waiterForOrder(order);
        waiterId = w.waiterId;
        waiterName = w.waiterName;
      }
      const sectionName = sectionNameById(plan, t.sectionId);
      const reservationsToday = reservationsByTableId.get(t.id);
      return {
        ...t,
        sectionId: t.sectionId,
        sectionName,
        status,
        elapsedMinutes,
        itemCount,
        total,
        waiterId,
        waiterName,
        ...(reservationsToday?.length ? { reservationsToday } : {})
      };
    });
    const bySection = plan.sections.map((sec) => ({
      sectionId: sec.id,
      sectionName: sec.name,
      tables: tableStatuses.filter((t) => t.sectionId === sec.id)
    }));
    res.json(bySection);
  });

  // Catalog & inventory (simplified)
  pub.get("/products", (_req, res) => {
    res.json(menuProducts());
  });
  prot.post("/products", (req: Request, res: Response) => {
    const { name, price, category, type, sku, costPrice, imageUrl } = req.body as { name?: string; price?: number; category?: string; type?: "veg" | "non_veg" | "egg"; sku?: string; costPrice?: number; imageUrl?: string };
    if (!name || price == null || price < 0) {
      return res.status(400).json({ error: "name and price (>= 0) are required" });
    }
    const validType = type && ["veg", "non_veg", "egg"].includes(type) ? type : "veg";
    const maxP = menuProducts().reduce((m, p) => {
      const n = parseInt(String(p.id).replace(/\D/g, ""), 10) || 0;
      return Math.max(m, n);
    }, 0);
    const newProduct: Product = {
      id: `P${maxP + 1}`,
      name: name.trim(),
      price,
      category: category?.trim() || undefined,
      type: validType,
      sku: sku?.trim() || undefined,
      costPrice: costPrice != null && costPrice >= 0 ? costPrice : undefined,
      imageUrl: imageUrl?.trim() || undefined
    };
    menuProducts().push(newProduct);
    saveProducts(menuProducts());
    seedNewProductInventoryRow(newProduct.id);
    res.status(201).json(newProduct);
  });
  prot.patch("/products/:id", (req: Request, res: Response) => {
    const { id } = req.params;
    const { name, price, category, type, sku, costPrice, archived, imageUrl } = req.body as Partial<Product>;
    const prod = menuProducts().find((p) => p.id === id);
    if (!prod) return res.status(404).json({ error: "Product not found" });
    if (name !== undefined) prod.name = name.trim();
    if (price !== undefined && price >= 0) prod.price = price;
    if (category !== undefined) prod.category = category?.trim() || undefined;
    if (type !== undefined && ["veg", "non_veg", "egg"].includes(type)) prod.type = type;
    if (sku !== undefined) prod.sku = sku?.trim() || undefined;
    if (costPrice !== undefined) {
      if (costPrice === null) prod.costPrice = undefined;
      else if (typeof costPrice === "number" && costPrice >= 0) prod.costPrice = costPrice;
      else prod.costPrice = undefined;
    }
    if (archived !== undefined) prod.archived = !!archived;
    if (imageUrl !== undefined) prod.imageUrl = imageUrl?.trim() || undefined;
    saveProducts(menuProducts());
    res.json(prod);
  });
  prot.delete("/products/:id", (req: Request, res: Response) => {
    const { id } = req.params;
    const idx = menuProducts().findIndex((p) => p.id === id);
    if (idx < 0) return res.status(404).json({ error: "Product not found" });
    menuProducts().splice(idx, 1);
    const recipeLines = menuRecipes();
    const before = recipeLines.length;
    for (let i = recipeLines.length - 1; i >= 0; i--) {
      if (recipeLines[i].productId === id) recipeLines.splice(i, 1);
    }
    saveProducts(menuProducts());
    saveRecipes(menuRecipes());
    dropProductInventoryRow(id);
    res.json({ deleted: id, recipesRemoved: before - recipeLines.length });
  });

  // POS products with 86/availability (auto-disable when ingredient stock too low)
  function getProductAvailability(): Map<string, boolean> {
    const avail = new Map<string, boolean>();
    for (const p of menuProducts()) {
      if (!p?.id) continue;
      const lines = menuRecipes().filter((r) => r && r.productId === p.id);
      if (lines.length === 0) {
        avail.set(p.id, true);
        continue;
      }
      let canMake = true;
      for (const line of lines) {
        const ing = menuIngredients().find((i) => i != null && i.id === line.ingredientId);
        if (!ing || ing.stock_quantity < line.qty) {
          canMake = false;
          break;
        }
      }
      avail.set(p.id, canMake);
    }
    return avail;
  }
  prot.get("/stock", (_req, res) => {
    const availability = getProductAvailability();
    const list = menuProducts().map((p) => {
      const inv = inventoryMap.get(p.id) ?? { productId: p.id, qty: 0, unit: "pcs", lowStock: 10 };
      const lines = menuRecipes().filter((r) => r && r.productId === p.id);
      let recipeCost = 0;
      for (const line of lines) {
        const ing = menuIngredients().find((i) => i != null && i.id === line.ingredientId);
        recipeCost += (ing?.costPerUnit ?? 0) * line.qty;
      }
      const costPrice = p.costPrice ?? recipeCost;
      const qty = inv.qty;
      const inStock = availability.get(p.id) ?? (qty > 0);
      const lowStock = inv.lowStock ?? 10;
      const isLowStock = qty > 0 && qty <= lowStock;
      return { ...p, sku: p.sku ?? p.id, costPrice, stockQty: qty, unit: inv.unit, lowStock, inStock, isLowStock, recipeCost };
    });
    res.json(list);
  });

  /** Menu for POS and for QR customer ordering (availability + 86); omits archived items. */
  pub.get("/products/pos", (_req, res) => {
    const availability = getProductAvailability();
    const list = menuProducts()
      .filter((p) => !p.archived)
      .map((p) => ({
        ...p,
        outOfStock: !availability.get(p.id)
      }));
    res.json(list);
  });

  // Inventory (product + stock)
  type InventoryItem = ProductInventoryRow;
  const inventoryMap = new Map<string, InventoryItem>();
  const savedRows = loadProductInventoryRowsFromDisk();
  const savedByPid = new Map(savedRows.map((r) => [r.productId, r]));
  menuProducts().forEach((p) => {
    const saved = savedByPid.get(p.id);
    if (saved) {
      inventoryMap.set(p.id, {
        productId: p.id,
        qty: Math.max(0, Number(saved.qty) || 0),
        unit: saved.unit || "pcs",
        lowStock: Math.max(0, Number(saved.lowStock) || 10)
      });
    } else {
      inventoryMap.set(p.id, {
        productId: p.id,
        qty: DEFAULT_PRODUCT_STOCK_QTY,
        unit: "pcs",
        lowStock: 10
      });
    }
  });

  /** If qty never left the default but paid orders exist, sales were not applied — align with lifetime paid qty. */
  const lifeSold = lifetimePaidQtyByProductId();
  let reconciledAny = false;
  for (const p of menuProducts()) {
    if (!p?.id || p.archived) continue;
    const row = inventoryMap.get(p.id);
    if (!row) continue;
    const sold = lifeSold.get(p.id) ?? 0;
    if (sold > 0 && row.qty === DEFAULT_PRODUCT_STOCK_QTY) {
      row.qty = Math.max(0, DEFAULT_PRODUCT_STOCK_QTY - sold);
      inventoryMap.set(p.id, row);
      reconciledAny = true;
    }
  }
  if (reconciledAny) {
    console.warn(
      "[inventory] Reconciled product stock: default qty with paid sales → adjusted (see product-inventory.json)"
    );
    persistProductInventoryImmediate(inventoryMap);
  }

  productInventoryRuntimeMap = inventoryMap;

  function ensureInventoryRow(productId: string): InventoryItem | null {
    const pid = String(productId || "").trim();
    if (!pid) return null;
    let cur = inventoryMap.get(pid);
    if (cur) return cur;
    const prod = menuProducts().find((x) => x != null && x.id === pid);
    if (!prod || prod.archived) return null;
    cur = { productId: pid, qty: DEFAULT_PRODUCT_STOCK_QTY, unit: "pcs", lowStock: 10 };
    inventoryMap.set(pid, cur);
    return cur;
  }

  prot.get("/inventory", (_req, res) => {
    const list = menuProducts().map((p) => {
      const inv = inventoryMap.get(p.id) ?? { productId: p.id, qty: 0, unit: "pcs", lowStock: 10 };
      return { ...p, stockQty: inv.qty, unit: inv.unit, lowStock: inv.lowStock };
    });
    res.json(list);
  });

  /**
   * Admin: set each menu item's on-hand qty to `baseline − (all-time paid sales qty)`.
   * Overwrites current /inventory numbers; use after bad data or changing baseline.
   */
  prot.post("/inventory/rebuild-from-sales", (req: Request, res: Response) => {
    const raw = (req.body as { baseline?: unknown })?.baseline;
    const baseline =
      raw != null && Number.isFinite(Number(raw)) && Number(raw) >= 0
        ? Math.max(0, Math.floor(Number(raw)))
        : DEFAULT_PRODUCT_STOCK_QTY;
    const lifeSold = lifetimePaidQtyByProductId();
    const items: { productId: string; name: string; qty: number; lifetimeSold: number }[] = [];
    for (const p of menuProducts()) {
      if (!p?.id || p.archived) continue;
      const sold = lifeSold.get(p.id) ?? 0;
      const qty = Math.max(0, baseline - sold);
      const prev = inventoryMap.get(p.id);
      const row: InventoryItem = {
        productId: p.id,
        qty,
        unit: prev?.unit ?? "pcs",
        lowStock: prev?.lowStock ?? 10
      };
      inventoryMap.set(p.id, row);
      items.push({ productId: p.id, name: p.name, qty, lifetimeSold: sold });
    }
    persistProductInventoryImmediate(inventoryMap);
    res.json({
      ok: true,
      baseline,
      message: `Set stock from baseline ${baseline} minus lifetime paid quantities.`,
      itemCount: items.length,
      items
    });
  });

  prot.patch("/inventory/:productId", (req: Request, res: Response) => {
    const { productId } = req.params;
    const { qty, unit, lowStock } = req.body as Partial<InventoryItem>;
    const prod = menuProducts().find((p) => p.id === productId);
    if (!prod) return res.status(404).json({ error: "Product not found" });
    const cur = inventoryMap.get(productId) ?? { productId, qty: 0, unit: "pcs", lowStock: 10 };
    if (qty !== undefined) cur.qty = Math.max(0, qty);
    if (unit !== undefined) cur.unit = unit;
    if (lowStock !== undefined) cur.lowStock = lowStock;
    inventoryMap.set(productId, cur);
    schedulePersistProductInventory(inventoryMap);
    res.json(cur);
  });

  /** Run at payment: recipe → ingredient stock; also decrement Products /inventory counts when tracked. */
  function finalizeSaleInventory(order: Order): InventoryDeductionResult {
    const lines = order.items.map((i) => ({
      id: i.id,
      qty: Math.max(1, Math.floor(Number(i.qty) || 1))
    }));
    const result = deductIngredientsForOrder(lines);
    for (const it of order.items) {
      const pid = String(it.id || "").trim();
      if (!pid) continue;
      const q = Math.max(1, Math.floor(Number(it.qty) || 1));
      const prod = menuProducts().find((x) => x != null && x.id === pid);
      if (!prod || prod.archived) continue;
      const cur = ensureInventoryRow(pid);
      if (!cur) continue;
      cur.qty = Math.max(0, (Number(cur.qty) || 0) - q);
      inventoryMap.set(pid, cur);
    }
    schedulePersistProductInventory(inventoryMap);
    try {
      saveIngredients(menuIngredients());
    } catch (e) {
      console.error("[inventory] saveIngredients after sale failed:", e);
    }
    return result;
  }

  // Ingredients (recipe-based raw materials)
  prot.get("/ingredients", (_req, res) => {
    res.json(menuIngredients());
  });

  /**
   * Day-end style view: paid sales in range, items sold, recipe-based ingredient usage,
   * and current on-hand ingredient stock (live — not a historical snapshot).
   */
  prot.get("/closing-stock", (req: Request, res: Response) => {
    const d0 = new Date();
    const y = d0.getFullYear();
    const mo = String(d0.getMonth() + 1).padStart(2, "0");
    const day = String(d0.getDate()).padStart(2, "0");
    const defaultDate = `${y}-${mo}-${day}`;
    const rawDate = (req.query.date as string) || defaultDate;
    const range = (req.query.range as string) === "7d" ? "7d" : "day";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) {
      return res.status(400).json({ error: "Invalid date. Use YYYY-MM-DD" });
    }
    let fromMs: number;
    let toMs: number;
    if (range === "7d") {
      const end = new Date(`${rawDate}T23:59:59.999`);
      toMs = end.getTime();
      const start = new Date(end);
      start.setDate(start.getDate() - 6);
      start.setHours(0, 0, 0, 0);
      fromMs = start.getTime();
    } else {
      fromMs = new Date(`${rawDate}T00:00:00.000`).getTime();
      toMs = new Date(`${rawDate}T23:59:59.999`).getTime();
    }
    const paidList = paidOrdersInLocalRange(fromMs, toMs);
    const linesSold = flattenSoldLinesForClosingStock(paidList);
    const itemsSoldRaw = aggregateItemsSoldForClosingStock(paidList);
    const salesById = new Map(itemsSoldRaw.map((r) => [r.id, r]));

    const enrichClosingStockMenuRow = (r: { id: string; name: string; qty: number; revenue: number }) => {
      const inv =
        inventoryMap.get(r.id) ??
        (menuProducts().some((p) => p != null && p.id === r.id)
          ? ({ productId: r.id, qty: 0, unit: "pcs", lowStock: 10 } satisfies InventoryItem)
          : undefined);
      if (inv) {
        return {
          ...r,
          remainingQty: Math.round((Number(inv.qty) || 0) * 1000) / 1000,
          stockUnit: String(inv.unit || "pcs")
        };
      }
      return { ...r, remainingQty: null as number | null, stockUnit: null as string | null };
    };

    /** Full menu: every active dish appears (0 sold if none in period); plus sold rows missing from menu. */
    const menuIds = new Set<string>();
    const itemsSold: ReturnType<typeof enrichClosingStockMenuRow>[] = [];
    for (const p of menuProducts()) {
      if (!p?.id || p.archived) continue;
      menuIds.add(p.id);
      const s = salesById.get(p.id);
      itemsSold.push(
        enrichClosingStockMenuRow({
          id: p.id,
          name: p.name,
          qty: s?.qty ?? 0,
          revenue: s?.revenue ?? 0
        })
      );
    }
    for (const r of itemsSoldRaw) {
      if (menuIds.has(r.id)) continue;
      itemsSold.push(enrichClosingStockMenuRow(r));
    }
    itemsSold.sort((a, b) => {
      const sa = a.qty > 0 ? 1 : 0;
      const sb = b.qty > 0 ? 1 : 0;
      if (sa !== sb) return sb - sa;
      return a.name.localeCompare(b.name);
    });
    const ingredientConsumption = aggregateIngredientConsumptionForClosingStock(paidList);
    const consumedById = new Map(ingredientConsumption.map((r) => [r.ingredientId, r.consumed]));
    /** Only ingredients that were used by this period’s paid sales (not the full inventory list). */
    const closingStock = [...menuIngredients()]
      .filter((i) => (consumedById.get(i.id) ?? 0) > 0)
      .map((i) => ({
        id: i.id,
        name: i.name,
        unit: i.unit,
        stock_quantity: Math.round(i.stock_quantity * 1000) / 1000,
        low_stock_threshold: i.low_stock_threshold,
        inRecipe: menuRecipes().some((r) => r.ingredientId === i.id),
        consumedThisPeriod: Math.round((consumedById.get(i.id) ?? 0) * 1000) / 1000
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const ordersSummary = paidList
      .slice()
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, 80)
      .map((o) => ({
        id: o.id,
        tableId: o.tableId,
        total: Math.round(calculateTotal(o.items) * 100) / 100,
        createdAt: o.createdAt,
        itemLines: o.items.length,
        items: o.items.map((it) => ({
          id: it.id,
          name: it.name,
          qty: Math.max(1, Math.floor(Number(it.qty) || 1)),
          lineTotal: Math.round((Number(it.price) || 0) * Math.max(1, Math.floor(Number(it.qty) || 1)) * 100) / 100
        }))
      }));

    res.json({
      date: rawDate,
      range,
      periodLabel: range === "7d" ? `7 days ending ${rawDate}` : `${rawDate} (full day)`,
      orderCount: paidList.length,
      linesSold,
      itemsSold,
      ingredientConsumption,
      closingStock,
      orders: ordersSummary,
      note:
        "Only lines from paid (completed) bills in this period. Pick «This day» for everything sold from midnight on the date shown."
    });
  });

  prot.post("/ingredients", (req: Request, res: Response) => {
    const body = req.body as {
      name?: string;
      unit?: string;
      low_stock_threshold?: number;
      lowStock?: number;
      stock_quantity?: number;
      stockQty?: number;
      costPerUnit?: number;
    };
    const { name, unit, costPerUnit } = body;
    const lowRaw = body.low_stock_threshold ?? body.lowStock;
    const stockRaw = body.stock_quantity ?? body.stockQty;
    if (!name || !unit) {
      return res.status(400).json({ error: "name and unit are required" });
    }
    const uNorm = normalizeIngredientUnit(String(unit));
    if (!uNorm) {
      return res.status(400).json({ error: "unit must be one of: kg, pcs, litre" });
    }
    const maxNum = menuIngredients().reduce((m, x) => {
      const n = parseInt(String(x.id).replace(/\D/g, ""), 10) || 0;
      return Math.max(m, n);
    }, 0);
    const newIngredient: Ingredient = {
      id: `I${maxNum + 1}`,
      name: name.trim(),
      unit: uNorm,
      stock_quantity:
        stockRaw != null && Number.isFinite(Number(stockRaw)) ? Math.max(0, Number(stockRaw)) : 0,
      low_stock_threshold:
        lowRaw != null && Number(lowRaw) >= 0 ? Number(lowRaw) : 0,
      costPerUnit: costPerUnit != null && costPerUnit >= 0 ? costPerUnit : undefined
    };
    menuIngredients().push(newIngredient);
    saveIngredients(menuIngredients());
    res.status(201).json(newIngredient);
  });
  prot.patch("/ingredients/:id", (req: Request, res: Response) => {
    const { id } = req.params;
    const body = req.body as Partial<Ingredient> & { stockQty?: number; lowStock?: number };
    const stockRaw = body.stock_quantity ?? body.stockQty;
    const lowRaw = body.low_stock_threshold ?? body.lowStock;
    const ing = menuIngredients().find((i) => i != null && i.id === id);
    if (!ing) return res.status(404).json({ error: "Ingredient not found" });
    if (stockRaw !== undefined) ing.stock_quantity = Math.max(0, Number(stockRaw));
    if (lowRaw !== undefined) ing.low_stock_threshold = Math.max(0, Number(lowRaw));
    if (body.unit !== undefined) {
      const uNorm = normalizeIngredientUnit(String(body.unit));
      if (!uNorm) {
        return res.status(400).json({ error: "unit must be one of: kg, pcs, litre" });
      }
      ing.unit = uNorm;
    }
    if (body.costPerUnit !== undefined) ing.costPerUnit = body.costPerUnit >= 0 ? body.costPerUnit : undefined;
    saveIngredients(menuIngredients());
    res.json(ing);
  });
  prot.delete("/ingredients/:id", (req: Request, res: Response) => {
    const { id } = req.params;
    const used = menuRecipes().some((r) => r.ingredientId === id);
    if (used) {
      return res.status(400).json({ error: "Cannot delete: ingredient is used in recipes. Remove from recipes first." });
    }
    const idx = menuIngredients().findIndex((i) => i != null && i.id === id);
    if (idx < 0) return res.status(404).json({ error: "Ingredient not found" });
    menuIngredients().splice(idx, 1);
    saveIngredients(menuIngredients());
    res.json({ deleted: id });
  });
  prot.post("/ingredients/:id/adjust", (req: Request, res: Response) => {
    const { id } = req.params;
    const { delta } = req.body as { delta?: number };
    if (delta == null || typeof delta !== "number") {
      return res.status(400).json({ error: "delta (number) is required" });
    }
    const ing = menuIngredients().find((i) => i != null && i.id === id);
    if (!ing) return res.status(404).json({ error: "Ingredient not found" });
    ing.stock_quantity = Math.max(0, ing.stock_quantity + delta);
    saveIngredients(menuIngredients());
    res.json(ing);
  });

  // Smart low-stock alerts (sales velocity)
  prot.get("/inventory/alerts", (_req, res) => {
    const days = 7;
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const recentOrders = orders.filter(
      (o) => new Date(o.createdAt).getTime() >= cutoff && o.status !== "cancelled"
    );
    const usageByIng = new Map<string, number>();
    for (const o of recentOrders) {
      for (const item of o.items) {
        const qty = item.qty ?? 1;
        for (const r of menuRecipes().filter((r) => r && r.productId === item.id)) {
          const cur = usageByIng.get(r.ingredientId) ?? 0;
          usageByIng.set(r.ingredientId, cur + r.qty * qty);
        }
      }
    }
    const dailyUsage = new Map<string, number>();
    usageByIng.forEach((v, k) => dailyUsage.set(k, v / days));

    const alerts = menuIngredients().map((i) => {
      const consumed = usageByIng.get(i.id) ?? 0;
      const perDay = dailyUsage.get(i.id) ?? 0;
      const daysLeft = perDay > 0 ? i.stock_quantity / perDay : 999;
      const isLow = i.stock_quantity <= i.low_stock_threshold;
      const shortfall = Math.max(0, i.low_stock_threshold - i.stock_quantity);
      const bufferDays = 7;
      const suggestedBuy = isLow
        ? Math.max(shortfall, perDay > 0 ? Math.ceil(perDay * bufferDays) : i.low_stock_threshold)
        : 0;
      return {
        ...i,
        consumptionLast7Days: Math.round(consumed * 1000) / 1000,
        consumptionPerDay: Math.round(perDay * 1000) / 1000,
        daysUntilEmpty: perDay > 0 ? Math.round(daysLeft * 10) / 10 : null,
        isLow,
        suggestedBuy: Math.round(suggestedBuy * 1000) / 1000
      };
    });
    res.json(alerts);
  });

  /** Human-readable run-out estimates (same logic as dashboard runoutAlerts). */
  prot.get("/inventory/run-out-alerts", (_req, res) => {
    res.json({
      lookbackDays: INVENTORY_RUNOUT_LOOKBACK_DAYS,
      alerts: buildInventoryRunoutAlerts()
    });
  });

  // Menu costing: recipe cost, margin per dish
  prot.get("/inventory/menu-costing", (_req, res) => {
    const list = menuProducts().map((p) => {
      const lines = menuRecipes().filter((r) => r && r.productId === p.id);
      let recipeCost = 0;
      const breakdown: { ingredientName: string; qty: number; cost: number }[] = [];
      for (const line of lines) {
        const ing = menuIngredients().find((i) => i != null && i.id === line.ingredientId);
        const costPerUnit = ing?.costPerUnit ?? 0;
        const cost = line.qty * costPerUnit;
        recipeCost += cost;
        breakdown.push({ ingredientName: ing?.name ?? line.ingredientId, qty: line.qty, cost });
      }
      const recipeCostR = Math.round(recipeCost * 100) / 100;
      const manual = p.costPrice;
      const effectiveCost =
        manual != null && typeof manual === "number" && manual >= 0 ? Math.round(manual * 100) / 100 : recipeCostR;
      const sellPrice = p.price;
      const margin = sellPrice > 0 ? ((sellPrice - effectiveCost) / sellPrice) * 100 : 0;
      return {
        productId: p.id,
        productName: p.name,
        sellPrice,
        recipeCost: recipeCostR,
        manualCostPrice: manual != null && manual >= 0 ? Math.round(manual * 100) / 100 : null,
        effectiveCost,
        margin: Math.round(margin * 10) / 10,
        breakdown
      };
    });
    res.json(list);
  });

  // Recipes (product -> ingredients)
  /** Flat recipe mapping: product → ingredient usage per 1 product unit */
  prot.get("/recipes/lines", (_req, res) => {
    res.json(
      menuRecipes().map((r) => ({
        product_id: r.productId,
        ingredient_id: r.ingredientId,
        quantity_used: r.qty
      }))
    );
  });
  prot.get("/recipes", (_req, res) => {
    const metaByPid = new Map(loadRecipeProductMeta().map((m) => [m.productId, m]));
    const list = menuProducts().map((p) => {
      const lines = menuRecipes().filter((r) => r && r.productId === p.id);
      const meta = metaByPid.get(p.id);
      return {
        productId: p.id,
        productName: p.name,
        aiRecipe: meta
          ? { confidence: meta.confidence, needsReview: meta.needsReview, source: meta.source }
          : null,
        ingredients: lines.map((l) => {
          const ing = menuIngredients().find((i) => i != null && i.id === l.ingredientId);
          return {
            ingredientId: l.ingredientId,
            ingredientName: ing?.name ?? l.ingredientId,
            qty: l.qty,
            quantity_used: l.qty
          };
        })
      };
    });
    res.json(list);
  });
  prot.post("/recipes", (req: Request, res: Response) => {
    const body = req.body as Record<string, unknown>;
    const productId = String(body.productId ?? body.product_id ?? "").trim();
    const ingredientId = String(body.ingredientId ?? body.ingredient_id ?? "").trim();
    const qtyRaw = body.qty ?? body.quantity_used;
    const qty = Number(qtyRaw);
    if (!productId || !ingredientId || qty == null || !Number.isFinite(qty) || qty < 0) {
      return res
        .status(400)
        .json({ error: "productId, ingredientId, and qty (or quantity_used) are required" });
    }
    const idx = menuRecipes().findIndex((r) => r.productId === productId && r.ingredientId === ingredientId);
    if (idx >= 0) menuRecipes()[idx].qty = qty;
    else menuRecipes().push({ productId, ingredientId, qty });
    saveRecipes(menuRecipes());
    res.status(201).json({ productId, ingredientId, qty, quantity_used: qty });
  });
  prot.delete("/recipes", (req: Request, res: Response) => {
    const { productId, ingredientId } = req.body as { productId?: string; ingredientId?: string };
    if (!productId || !ingredientId) {
      return res.status(400).json({ error: "productId and ingredientId are required in body" });
    }
    const idx = menuRecipes().findIndex((r) => r.productId === productId && r.ingredientId === ingredientId);
    if (idx < 0) return res.status(404).json({ error: "Recipe line not found" });
    menuRecipes().splice(idx, 1);
    saveRecipes(menuRecipes());
    res.json({ deleted: { productId, ingredientId } });
  });

  // Purchase (add stock) - creates batch with expiry
  prot.get("/purchases", (_req, res) => {
    const enriched = purchases.slice(-100).reverse().map((p) => {
      const ing = menuIngredients().find((i) => i != null && i.id === p.ingredientId);
      return { ...p, ingredientName: ing?.name ?? p.ingredientId };
    });
    res.json(enriched);
  });
  prot.post("/purchases", (req: Request, res: Response) => {
    const body = req.body as Partial<Purchase> & {
      expiryDate?: string;
      payment_method?: MoneyPaymentMethod;
    };
    const { ingredientId, qty, supplier, billNo, cost, expiryDate } = body;
    if (!ingredientId || qty == null || qty <= 0) {
      return res.status(400).json({ error: "ingredientId and qty required" });
    }
    const ing = menuIngredients().find((i) => i != null && i.id === ingredientId);
    if (!ing) return res.status(404).json({ error: "Ingredient not found" });
    const qtyNum = Number(qty);
    if (!Number.isFinite(qtyNum) || qtyNum <= 0) {
      return res.status(400).json({ error: "qty must be a positive number" });
    }

    ing.stock_quantity += qtyNum;

    const maxPu = purchases.reduce((m, x) => {
      const n = parseInt(String(x.id).replace(/\D/g, ""), 10) || 0;
      return Math.max(m, n);
    }, 0);
    const p: Purchase = {
      id: `PU${maxPu + 1}`,
      ingredientId,
      qty: qtyNum,
      supplier: supplier?.trim() || undefined,
      billNo: billNo?.trim() || undefined,
      cost: cost != null && Number.isFinite(Number(cost)) ? Number(cost) : undefined,
      createdAt: new Date().toISOString()
    };

    const exp = expiryDate
      ? new Date(expiryDate).toISOString().slice(0, 10)
      : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const maxB = batches.reduce((m, x) => {
      const n = parseInt(String(x.id).replace(/\D/g, ""), 10) || 0;
      return Math.max(m, n);
    }, 0);
    batches.push({
      id: `B${maxB + 1}`,
      ingredientId,
      qty: qtyNum,
      remainingQty: qtyNum,
      expiryDate: exp,
      purchaseId: p.id
    });

    let expenseTransaction: MoneyTransaction | null = null;
    const costNum = p.cost != null ? Number(p.cost) : NaN;
    if (Number.isFinite(costNum) && costNum > 0) {
      const pmRaw = body.payment_method;
      const pm: MoneyPaymentMethod =
        pmRaw === "card" || pmRaw === "upi" || pmRaw === "cash" ? pmRaw : "cash";
      const noteParts = [
        `Purchase ${p.id}`,
        `${ing.name} × ${qtyNum} ${ing.unit}`,
        billNo ? `Bill ${billNo}` : null,
        supplier ? supplier : null
      ].filter(Boolean);
      expenseTransaction = recordMoneyTransaction({
        type: "expense",
        amount: costNum,
        payment_method: pm,
        note: noteParts.join(" · ")
      });
      p.expenseTransactionId = expenseTransaction.id;
    }

    purchases.push(p);
    saveIngredients(menuIngredients());
    res.status(201).json({
      ...p,
      expiryDate: exp,
      expenseTransaction: expenseTransaction
        ? { id: expenseTransaction.id, amount: expenseTransaction.amount, payment_method: expenseTransaction.payment_method }
        : null
    });
  });

  // Purchase list (reorder list) — persisted to data/purchase-list.json
  prot.get("/purchase-list", (_req: Request, res: Response) => {
    const list = purchaseListRows
      .slice()
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .map((row) => {
        const ing = menuIngredients().find((i) => i != null && i.id === row.ingredient_id);
        const stock = ing != null ? Math.max(0, Number(ing.stock_quantity) || 0) : 0;
        const thr = ing != null ? Math.max(0, Number(ing.low_stock_threshold) || 0) : 0;
        const low_stock = ing != null && stock <= thr;
        return {
          ...row,
          ingredient_name: ing?.name ?? row.ingredient_id,
          unit: ing?.unit ?? "",
          low_stock,
          ...(ing != null ? { low_stock_threshold: thr, stock_quantity: stock } : {})
        };
      });
    res.json(list);
  });

  prot.post("/purchase-list", (req: Request, res: Response) => {
    const body = req.body as {
      ingredient_id?: string;
      quantity_needed?: number;
      supplier_name?: string;
      status?: PurchaseListStatus;
    };
    const ingredient_id = body.ingredient_id?.trim();
    const quantity_needed = Number(body.quantity_needed);
    if (!ingredient_id || !Number.isFinite(quantity_needed) || quantity_needed <= 0) {
      return res.status(400).json({ error: "ingredient_id and positive quantity_needed are required" });
    }
    if (!menuIngredients().some((i) => i != null && i.id === ingredient_id)) {
      return res.status(404).json({ error: "Ingredient not found" });
    }
    if (findActivePurchaseRowForIngredient(ingredient_id)) {
      return res.status(409).json({
        error: "This ingredient already has an active line (pending or ordered). Edit it or remove it first."
      });
    }
    let status: PurchaseListStatus = "pending";
    if (body.status === "ordered" || body.status === "purchased") status = body.status;
    const maxId = purchaseListRows.reduce((m, x) => {
      const n = parseInt(String(x.id).replace(/\D/g, ""), 10) || 0;
      return Math.max(m, n);
    }, 0);
    const row: PurchaseListRow = {
      id: `PL${maxId + 1}`,
      ingredient_id,
      quantity_needed: Math.round(quantity_needed * 1000) / 1000,
      supplier_name: body.supplier_name?.trim() || undefined,
      status,
      created_at: new Date().toISOString(),
      source: "manual"
    };
    purchaseListRows.push(row);
    savePurchaseList();
    const ing = menuIngredients().find((i) => i.id === ingredient_id);
    res.status(201).json({
      ...row,
      ingredient_name: ing?.name ?? ingredient_id,
      unit: ing?.unit ?? ""
    });
  });

  prot.patch("/purchase-list/:id", (req: Request, res: Response) => {
    const { id } = req.params;
    const row = purchaseListRows.find((r) => r.id === id);
    if (!row) return res.status(404).json({ error: "Purchase list item not found" });
    const body = req.body as Partial<{
      quantity_needed: number;
      supplier_name: string | null;
      status: PurchaseListStatus;
    }>;
    if (body.quantity_needed != null) {
      const q = Number(body.quantity_needed);
      if (!Number.isFinite(q) || q <= 0) {
        return res.status(400).json({ error: "quantity_needed must be a positive number" });
      }
      row.quantity_needed = Math.round(q * 1000) / 1000;
      row.source = "manual";
    }
    if (body.supplier_name !== undefined) {
      row.supplier_name = body.supplier_name?.trim() || undefined;
      row.source = "manual";
    }
    if (body.status != null) {
      if (body.status !== "pending" && body.status !== "ordered" && body.status !== "purchased") {
        return res.status(400).json({ error: "status must be pending, ordered, or purchased" });
      }
      row.status = body.status;
    }
    savePurchaseList();
    const ing = menuIngredients().find((i) => i != null && i.id === row.ingredient_id);
    res.json({
      ...row,
      ingredient_name: ing?.name ?? row.ingredient_id,
      unit: ing?.unit ?? ""
    });
  });

  prot.delete("/purchase-list/:id", (req: Request, res: Response) => {
    const idx = purchaseListRows.findIndex((r) => r.id === req.params.id);
    if (idx < 0) return res.status(404).json({ error: "Purchase list item not found" });
    purchaseListRows.splice(idx, 1);
    savePurchaseList();
    res.json({ deleted: req.params.id });
  });

  // Batches & expiry
  prot.get("/batches", (req: Request, res: Response) => {
    const ingredientId = req.query.ingredientId as string | undefined;
    let list = batches.filter((b) => b.remainingQty > 0);
    if (ingredientId) list = list.filter((b) => b.ingredientId === ingredientId);
    list = list.sort((a, b) => new Date(a.expiryDate).getTime() - new Date(b.expiryDate).getTime());
    const enriched = list.map((b) => {
      const ing = menuIngredients().find((i) => i != null && i.id === b.ingredientId);
      const exp = new Date(b.expiryDate);
      const today = new Date();
      const daysLeft = Math.ceil((exp.getTime() - today.getTime()) / (24 * 60 * 60 * 1000));
      return {
        ...b,
        ingredientName: ing?.name,
        daysUntilExpiry: daysLeft
      };
    });
    res.json(enriched);
  });
  prot.get("/inventory/expiring", (req: Request, res: Response) => {
    const days = parseInt(req.query.days as string) || 7;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() + days);
    const list = batches
      .filter((b) => b.remainingQty > 0 && new Date(b.expiryDate) <= cutoff)
      .sort((a, b) => new Date(a.expiryDate).getTime() - new Date(b.expiryDate).getTime());
    const enriched = list.map((b) => {
      const ing = menuIngredients().find((i) => i != null && i.id === b.ingredientId);
      const exp = new Date(b.expiryDate);
      const today = new Date();
      const daysLeft = Math.ceil((exp.getTime() - today.getTime()) / (24 * 60 * 60 * 1000));
      const costPerUnit = ing?.costPerUnit ?? 0;
      const valueAtRisk = b.remainingQty * costPerUnit;
      return {
        ...b,
        ingredientName: ing?.name,
        unit: ing?.unit,
        daysUntilExpiry: daysLeft,
        costPerUnit,
        valueAtRisk: Math.round(valueAtRisk * 100) / 100
      };
    });
    res.json(enriched);
  });

  // Inventory value: invested money + value at risk (expiring)
  prot.get("/inventory/value", (_req, res) => {
    const totalInventoryValue = menuIngredients().reduce(
      (sum, i) => sum + (i.stock_quantity * (i.costPerUnit ?? 0)),
      0
    );
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    let valueExpiringToday = 0;
    let valueExpiringIn7Days = 0;
    for (const b of batches.filter((x) => x.remainingQty > 0)) {
      const ing = menuIngredients().find((i) => i != null && i.id === b.ingredientId);
      const cost = (ing?.costPerUnit ?? 0) * b.remainingQty;
      const exp = new Date(b.expiryDate);
      exp.setHours(0, 0, 0, 0);
      if (exp <= today) valueExpiringToday += cost;
      else if (exp <= new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000)) valueExpiringIn7Days += cost;
    }
    res.json({
      totalInventoryValue: Math.round(totalInventoryValue * 100) / 100,
      valueExpiringToday: Math.round(valueExpiringToday * 100) / 100,
      valueExpiringIn7Days: Math.round((valueExpiringToday + valueExpiringIn7Days) * 100) / 100
    });
  });

  // Notifications: protect invested money – alerts + "use today" dish suggestions
  prot.get("/inventory/notifications", (_req, res) => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const in7 = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000);
    const expiringToday = batches.filter(
      (b) => b.remainingQty > 0 && new Date(b.expiryDate) <= today
    );
    const expiring7d = batches.filter(
      (b) => b.remainingQty > 0 && new Date(b.expiryDate) > today && new Date(b.expiryDate) <= in7
    );
    let valueExpiringToday = 0;
    const expiringTodayIngIds = new Set<string>();
    for (const b of expiringToday) {
      const ing = menuIngredients().find((i) => i != null && i.id === b.ingredientId);
      valueExpiringToday += (ing?.costPerUnit ?? 0) * b.remainingQty;
      expiringTodayIngIds.add(b.ingredientId);
    }
    let valueExpiring7d = 0;
    for (const b of expiring7d) {
      const ing = menuIngredients().find((i) => i != null && i.id === b.ingredientId);
      valueExpiring7d += (ing?.costPerUnit ?? 0) * b.remainingQty;
    }
    const useTodayDishIds = new Set<string>();
    for (const r of menuRecipes()) {
      if (expiringTodayIngIds.has(r.ingredientId)) useTodayDishIds.add(r.productId);
    }
    const useTodayDishes = menuProducts().filter((p) => useTodayDishIds.has(p.id)).map((p) => p.name);
    const lowStockCount = menuIngredients().filter((i) => i.stock_quantity <= i.low_stock_threshold).length;
    const hasUrgent = valueExpiringToday > 0 || lowStockCount > 0;
    res.json({
      hasUrgent: !!hasUrgent,
      valueExpiringToday: Math.round(valueExpiringToday * 100) / 100,
      valueExpiringIn7Days: Math.round((valueExpiringToday + valueExpiring7d) * 100) / 100,
      useTodayDishes,
      lowStockCount,
      message: valueExpiringToday > 0
        ? `₹${valueExpiringToday.toFixed(2)} at risk today. ${useTodayDishes.length ? `Sell: ${useTodayDishes.join(", ")} to recover.` : "Record wastage if unusable."}`
        : lowStockCount > 0
          ? `${lowStockCount} item(s) low stock. Restock to avoid 86.`
          : null
    });
  });

  // Wastage (deduct stock)
  prot.get("/wastage", (_req, res) => {
    res.json(wastages.slice(-100).reverse());
  });
  prot.post("/wastage", (req: Request, res: Response) => {
    const body = req.body as Partial<Wastage> & { reason?: string; ingredientId?: string; productId?: string };
    const ingredientId =
      typeof body.ingredientId === "string" && body.ingredientId.trim() ? body.ingredientId.trim() : undefined;
    const productId =
      typeof body.productId === "string" && body.productId.trim() ? body.productId.trim() : undefined;
    const qtyNum = Number(body.qty);
    const { reason, note } = body;

    if ((ingredientId && productId) || (!ingredientId && !productId)) {
      return res.status(400).json({ error: "Provide exactly one of ingredientId or productId" });
    }
    if (!Number.isFinite(qtyNum) || qtyNum <= 0) {
      return res.status(400).json({ error: "qty must be a positive number" });
    }

    if (ingredientId) {
      const ing = menuIngredients().find((i) => i != null && i.id === ingredientId);
      if (!ing) return res.status(404).json({ error: "Ingredient not found" });
      deductFromBatches(ingredientId, qtyNum);
      ing.stock_quantity = Math.max(0, ing.stock_quantity - qtyNum);
      const w: Wastage = {
        id: `WA${wastages.length + 1}`,
        ingredientId,
        qty: qtyNum,
        reason: reason || "Other",
        note,
        createdAt: new Date().toISOString()
      };
      wastages.push(w);
      saveIngredients(menuIngredients());
      return res.status(201).json(w);
    }

    const pid = productId;
    if (!pid) return res.status(400).json({ error: "productId required" });
    const prod = menuProducts().find((p) => p != null && p.id === pid);
    if (!prod || prod.archived) return res.status(404).json({ error: "Product not found" });
    const dq = Math.floor(qtyNum);
    if (dq < 1) {
      return res.status(400).json({ error: "Product wastage quantity must be at least 1 whole unit" });
    }
    const cur = ensureInventoryRow(pid);
    if (!cur) return res.status(404).json({ error: "Product not found" });
    cur.qty = Math.max(0, (Number(cur.qty) || 0) - dq);
    inventoryMap.set(pid, cur);
    schedulePersistProductInventory(inventoryMap);
    const w: Wastage = {
      id: `WA${wastages.length + 1}`,
      productId: pid,
      qty: dq,
      reason: reason || "Other",
      note,
      createdAt: new Date().toISOString()
    };
    wastages.push(w);
    res.status(201).json(w);
  });

  // Expense (general business expenses)
  type Expense = {
    id: string;
    category: string;
    amount: number;
    note?: string;
    createdAt: string;
  };
  const EXPENSE_CATEGORIES = ["Rent", "Utilities", "Supplies", "Staff", "Maintenance", "Marketing", "Other"];
  const expenses: Expense[] = [];
  prot.get("/expenses", (req: Request, res: Response) => {
    const dateStr = req.query.date as string | undefined;
    const category = req.query.category as string | undefined;
    let list = [...expenses].reverse().slice(0, 200);
    if (dateStr) {
      const dayStart = new Date(dateStr);
      dayStart.setHours(0, 0, 0, 0);
      const dayEnd = new Date(dateStr);
      dayEnd.setHours(23, 59, 59, 999);
      list = list.filter((e) => {
        const d = new Date(e.createdAt).getTime();
        return d >= dayStart.getTime() && d <= dayEnd.getTime();
      });
    }
    if (category) list = list.filter((e) => e.category === category);
    res.json(list);
  });
  prot.post("/expenses", (req: Request, res: Response) => {
    const { category, amount, note } = req.body as { category?: string; amount?: number; note?: string };
    if (!category || amount == null || amount < 0) {
      return res.status(400).json({ error: "category and amount (>= 0) required" });
    }
    const e: Expense = {
      id: `EX${expenses.length + 1}`,
      category,
      amount,
      note,
      createdAt: new Date().toISOString()
    };
    expenses.push(e);
    recordMoneyTransaction({
      type: "expense",
      amount,
      payment_method: "cash",
      note: `${category}${note ? ` — ${note}` : ""}`
    });
    res.status(201).json(e);
  });

  prot.get("/expenses/categories", (_req, res) => {
    res.json(["Rent", "Utilities", "Supplies", "Staff", "Maintenance", "Marketing", "Other"]);
  });

  prot.get("/modifiers", (_req, res) => {
    res.json(globalModifiers);
  });

  // Money ledger (sales from billing, expenses, manual entries)
  prot.get("/transactions", (req: Request, res: Response) => {
    const type = req.query.type as string | undefined;
    const date = req.query.date as string | undefined;
    const fromQ = req.query.from as string | undefined;
    const toQ = req.query.to as string | undefined;
    const limit = Math.min(500, Math.max(1, parseInt(String(req.query.limit || "500"), 10) || 500));

    const dayOk = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
    let fromMs: number | undefined;
    let toMs: number | undefined;
    if (date && dayOk(date)) {
      fromMs = new Date(`${date}T00:00:00.000`).getTime();
      toMs = new Date(`${date}T23:59:59.999`).getTime();
    } else {
      if (fromQ && dayOk(fromQ)) fromMs = new Date(`${fromQ}T00:00:00.000`).getTime();
      if (toQ && dayOk(toQ)) toMs = new Date(`${toQ}T23:59:59.999`).getTime();
    }

    let list = [...moneyTransactions];
    if (fromMs !== undefined || toMs !== undefined) {
      list = list.filter((t) => {
        const x = new Date(t.created_at).getTime();
        if (fromMs !== undefined && x < fromMs) return false;
        if (toMs !== undefined && x > toMs) return false;
        return true;
      });
    }
    if (type && ["sale", "expense", "deposit", "withdrawal"].includes(type)) {
      list = list.filter((t) => t.type === type);
    }
    list.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    res.json(list.slice(0, limit));
  });

  /** Daily totals from the money ledger + vs previous calendar day */
  prot.get("/transactions/daily-summary", (req: Request, res: Response) => {
    const todayLocal = (): string => {
      const d = new Date();
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, "0");
      const day = String(d.getDate()).padStart(2, "0");
      return `${y}-${m}-${day}`;
    };
    const raw = (req.query.date as string) || todayLocal();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      return res.status(400).json({ error: "Invalid date. Use YYYY-MM-DD" });
    }
    const cur = aggregateMoneyDay(raw);
    const prevDate = previousCalendarDay(raw);
    const prev = aggregateMoneyDay(prevDate);

    const changePct = {
      sales: pctChangeDay(prev.sales, cur.sales),
      expenses: pctChangeDay(prev.expenses, cur.expenses),
      net: pctChangeDay(prev.net, cur.net),
      cash: pctChangeDay(prev.salesCash, cur.salesCash),
      upi: pctChangeDay(prev.salesUpi, cur.salesUpi),
      card: pctChangeDay(prev.salesCard, cur.salesCard)
    };

    res.json({
      date: raw,
      current: {
        sales: cur.sales,
        expenses: cur.expenses,
        net: cur.net,
        cash: cur.salesCash,
        upi: cur.salesUpi,
        card: cur.salesCard
      },
      compareDate: prevDate,
      previous: {
        sales: prev.sales,
        expenses: prev.expenses,
        net: prev.net,
        cash: prev.salesCash,
        upi: prev.salesUpi,
        card: prev.salesCard
      },
      changePct
    });
  });

  const todayLocalYmd = (): string => {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  };

  /** Cash drawer control: opening, ledger movement, expected vs counted closing */
  prot.get("/cash-control", (_req: Request, res: Response) => {
    const raw = (_req.query.date as string) || todayLocalYmd();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      return res.status(400).json({ error: "Invalid date. Use YYYY-MM-DD" });
    }
    const mov = aggregateCashMovement(raw);
    const opening = Number(cashControlData.openings[raw]) || 0;
    const countedRaw = cashControlData.countedClosings[raw];
    const countedDefined =
      countedRaw !== undefined && countedRaw !== null && !Number.isNaN(Number(countedRaw));
    const countedClosing = countedDefined ? Math.round(Number(countedRaw) * 100) / 100 : null;

    const expectedClosing =
      Math.round(
        (opening + mov.cashSales - mov.cashExpenses + mov.deposits - mov.withdrawals) * 100
      ) / 100;
    const formulaSimple =
      Math.round((opening + mov.cashSales - mov.cashExpenses) * 100) / 100;

    const eps = 0.009;
    const mismatch =
      countedClosing !== null && Math.abs(expectedClosing - countedClosing) > eps
        ? {
            expected: expectedClosing,
            counted: countedClosing,
            difference: Math.round((expectedClosing - countedClosing) * 100) / 100
          }
        : null;

    const daySales = aggregateMoneyDay(raw);
    /** UPI/QR and card are account settlements — never part of physical drawer math. */
    const notInDrawerSales = {
      upi: Math.round(daySales.salesUpi * 100) / 100,
      card: Math.round(daySales.salesCard * 100) / 100
    };

    const denominations = normalizeDenomEntry(cashControlData.denominationCounts[raw]);
    const denominationTotal = cashDenomTotal(denominations);
    const denomVsCountMismatch =
      countedClosing !== null && Math.abs(denominationTotal - countedClosing) > eps
        ? {
            fromNotes: denominationTotal,
            physicalEntry: countedClosing,
            difference: Math.round((denominationTotal - countedClosing) * 100) / 100
          }
        : null;

    const transactions = listCashLedgerLines(raw, 120);

    res.json({
      date: raw,
      opening,
      movement: mov,
      /** What should be in the drawer now (opening + cash in − cash out + deposits − withdrawals). */
      currentCash: expectedClosing,
      expectedClosing,
      /** Opening + cash sales − cash expenses only (no deposits/withdrawals). */
      formulaSimple,
      countedClosing,
      mismatch,
      notInDrawerSales,
      denominations,
      denominationTotal,
      denomVsCountMismatch,
      transactions
    });
  });

  prot.put("/cash-control/opening", (req: Request, res: Response) => {
    const { date, opening } = req.body as { date?: string; opening?: number };
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: "date (YYYY-MM-DD) is required" });
    }
    if (opening == null || Number.isNaN(Number(opening))) {
      return res.status(400).json({ error: "opening (number) is required" });
    }
    const v = Math.round(Number(opening) * 100) / 100;
    cashControlData.openings[date] = v;
    saveCashControl();
    res.json({ ok: true, date, opening: v });
  });

  prot.put("/cash-control/counted", (req: Request, res: Response) => {
    const { date, countedClosing, denominations } = req.body as {
      date?: string;
      countedClosing?: number | null;
      denominations?: {
        n500?: number;
        n100?: number;
        n50?: number;
        n20?: number;
        n10?: number;
        n5?: number;
      } | null;
    };
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: "date (YYYY-MM-DD) is required" });
    }
    if (countedClosing === null || countedClosing === undefined) {
      delete cashControlData.countedClosings[date];
      delete cashControlData.denominationCounts[date];
      saveCashControl();
      return res.json({ ok: true, date, countedClosing: null });
    }
    const v = Math.round(Number(countedClosing) * 100) / 100;
    if (Number.isNaN(v)) {
      return res.status(400).json({ error: "countedClosing must be a number or null" });
    }
    cashControlData.countedClosings[date] = v;
    if (denominations !== undefined) {
      if (denominations === null) {
        delete cashControlData.denominationCounts[date];
      } else {
        cashControlData.denominationCounts[date] = normalizeDenomEntry(denominations);
      }
    }
    saveCashControl();
    res.json({ ok: true, date, countedClosing: v });
  });

  prot.post("/transactions", (req: Request, res: Response) => {
    const { type, amount, payment_method, note } = req.body as {
      type?: MoneyTxType;
      amount?: number;
      payment_method?: MoneyPaymentMethod;
      note?: string;
    };
    if (!type || amount == null || Number(amount) <= 0) {
      return res.status(400).json({ error: "type and a positive amount are required" });
    }
    if (type === "sale") {
      return res
        .status(400)
        .json({ error: "Sales are recorded automatically when you complete payment in Billing" });
    }
    if (type !== "expense" && type !== "deposit" && type !== "withdrawal") {
      return res.status(400).json({ error: "type must be expense, deposit, or withdrawal" });
    }
    const pm = payment_method ?? "cash";
    if (!["cash", "card", "upi"].includes(pm)) {
      return res.status(400).json({ error: "payment_method must be cash, card, or upi" });
    }
    const t = recordMoneyTransaction({
      type,
      amount: Number(amount),
      payment_method: pm,
      note: note?.trim() || undefined
    });
    res.status(201).json(t);
  });

  // Customers
  prot.get("/customers", (req: Request, res: Response) => {
    const q = (req.query.q as string)?.toLowerCase() || "";
    const list = q
      ? customers.filter(
          (c) =>
            c.name.toLowerCase().includes(q) ||
            c.phone.includes(q) ||
            (c.email && c.email.toLowerCase().includes(q))
        )
      : customers;
    res.json(list);
  });
  prot.post("/customers", (req: Request, res: Response) => {
    const { name, phone, email, address, locality } = req.body as Partial<Customer>;
    if (!name || !phone) {
      return res.status(400).json({ error: "Name and phone are required" });
    }
    const id = `C${customers.length + 1}`;
    const c: Customer = {
      id,
      name,
      phone,
      email: email || undefined,
      address: address || undefined,
      locality: locality || undefined,
      createdAt: new Date().toISOString()
    };
    customers.push(c);
    res.status(201).json(c);
  });

  function mapGuestPortalStatusToPos(s: string): OrderStatus | null {
    const u = String(s || "").toUpperCase();
    if (u === "NEW") return "new";
    if (u === "PREPARING") return "cooking";
    if (u === "READY") return "ready";
    if (u === "COMPLETED") return "completed";
    if (u === "CANCELLED" || u === "CANCELED") return "cancelled";
    return null;
  }

  function mapPosStatusToGuestPortal(status: OrderStatus): string {
    if (status === "new") return "NEW";
    if (status === "cooking") return "PREPARING";
    if (status === "ready") return "READY";
    if (status === "served") return "SERVED";
    if (status === "completed") return "COMPLETED";
    if (status === "cancelled") return "CANCELLED";
    return String(status).toUpperCase();
  }

  // Create / append order for a table (KOT-style)
  pub.post("/orders", guestOrderPostLimiter, (req: Request, res: Response) => {
    try {
      const bodyRaw = req.body as Record<string, unknown>;
      const phoneGuest = typeof bodyRaw.phone === "string" ? bodyRaw.phone.trim() : "";
      const nameGuest = typeof bodyRaw.customerName === "string" ? bodyRaw.customerName.trim() : "";
      const totalGuest = typeof bodyRaw.total === "number" ? bodyRaw.total : undefined;
      const tableGuest =
        typeof bodyRaw.table === "string" && bodyRaw.table.trim()
          ? bodyRaw.table.trim()
          : typeof bodyRaw.tableId === "string"
            ? bodyRaw.tableId.trim()
            : "";
      const itemsRaw = bodyRaw.items;
      /** Guest QR page sends `phone` + `total` (POS uses customerMobile, no total). */
      const isGuestQrPayload =
        phoneGuest.length > 0 &&
        nameGuest.length > 0 &&
        totalGuest !== undefined &&
        tableGuest.length > 0 &&
        Array.isArray(itemsRaw) &&
        itemsRaw.length > 0;

      if (isGuestQrPayload) {
        try {
          const sid = getPosScope().storeId;
          if (!getStoreFeaturesForStore(sid).qrOrdering) {
            return res.status(403).json({ message: "Feature disabled", code: "FEATURE_DISABLED", feature: "qrOrdering" });
          }
        } catch {
          return res.status(503).json({ error: "Store context unavailable" });
        }
        const floor = menuFloorPlan();
        const resolvedGuestTable = resolveTableIdFromQrParam(tableGuest, floor.tables);
        if (!resolvedGuestTable) {
          return res.status(400).json({ error: "Unknown table" });
        }
        const tableExistsGuest =
          menuTables().some((t) => t.id === resolvedGuestTable) ||
          resolvedGuestTable === "TAKEAWAY" ||
          resolvedGuestTable === "DELIVERY";
        if (!tableExistsGuest) {
          return res.status(400).json({ error: "Unknown tableId" });
        }
        const guestItems: OrderItem[] = [];
        for (const row of itemsRaw) {
          if (!row || typeof row !== "object") continue;
          const i = row as Record<string, unknown>;
          const id = i.id != null ? String(i.id).trim() : "";
          if (!id) continue;
          const qty = Math.max(1, Math.floor(Number(i.qty) || 1));
          const price = Math.max(0, Number(i.price) || 0);
          const name = typeof i.name === "string" && i.name.trim() ? i.name.trim() : "Item";
          const mods = Array.isArray(i.modifiers) ? (i.modifiers as string[]) : undefined;
          const spec =
            typeof i.specialInstructions === "string" && i.specialInstructions.trim()
              ? i.specialInstructions.trim()
              : undefined;
          guestItems.push(
            normalizeItem({
              id,
              name,
              price,
              qty,
              category: typeof i.category === "string" ? i.category : undefined,
              type: i.type === "veg" || i.type === "non_veg" || i.type === "egg" ? i.type : undefined,
              sku: typeof i.sku === "string" ? i.sku : undefined,
              imageUrl: typeof i.imageUrl === "string" ? i.imageUrl : undefined,
              modifiers: mods,
              specialInstructions: spec
            })
          );
        }
        if (guestItems.length === 0) {
          return res.status(400).json({ error: "Each item needs a valid id and quantity" });
        }
        for (const it of guestItems) {
          const p = menuProducts().find((x) => x.id === it.id);
          if (!p || p.archived) {
            return res.status(400).json({
              error: `Item unavailable: ${it.name || it.id}`,
              code: "ITEM_UNAVAILABLE",
              productId: it.id
            });
          }
        }
        const calcGuestTotal = calculateTotal(guestItems);
        if (Math.abs(calcGuestTotal - totalGuest) > 0.05) {
          return res.status(400).json({ error: "Total does not match items" });
        }
        let storeIdMongo = LEGACY_DEFAULT_STORE_ID;
        try {
          storeIdMongo = getPosScope().storeId;
        } catch {
          /* no tenant — fallback */
        }
        const bodyStore = typeof bodyRaw.storeId === "string" ? bodyRaw.storeId.trim() : "";
        if (bodyStore) storeIdMongo = sanitizeStoreId(bodyStore);

        const clientRid =
          typeof bodyRaw.clientRequestId === "string" && bodyRaw.clientRequestId.trim()
            ? bodyRaw.clientRequestId.trim().slice(0, 128)
            : "";
        if (clientRid) {
          const dup = orders.find(
            (o) => o.lastClientRequestId === clientRid && o.customerMobile === phoneGuest
          );
          if (dup) {
            const payeeN = (appSettings.merchantUpiPayeeName || appSettings.companyName || "Cafe").trim();
            const vpaDup = appSettings.merchantUpiVpa.trim();
            let upiPayUrlDup: string | undefined;
            if (dup.guestPaymentStatus === "UPI_PENDING" && vpaDup && isValidUpiVpa(vpaDup)) {
              upiPayUrlDup = buildUpiIntentUrl(vpaDup, payeeN, calculateTotal(dup.items));
            }
            return res.status(200).json({
              id: dup.id,
              table: tableGuest,
              tableId: dup.tableId,
              storeId: dup.storeId || storeIdMongo,
              customerName: dup.customerName,
              phone: dup.customerMobile,
              status: mapPosStatusToGuestPortal(dup.status),
              total: calculateTotal(dup.items),
              items: dup.items,
              guestPaymentStatus: dup.guestPaymentStatus,
              duplicateOfClientRequest: true,
              ...(upiPayUrlDup ? { upiPayUrl: upiPayUrlDup } : {})
            });
          }
        }

        const paymentModeRaw = String(bodyRaw.paymentMode || "counter").toLowerCase();
        const paymentMode: "counter" | "upi" =
          paymentModeRaw === "upi" || paymentModeRaw === "pay_by_upi" ? "upi" : "counter";

        if (paymentMode === "upi") {
          const vpa = appSettings.merchantUpiVpa.trim();
          if (!isValidUpiVpa(vpa)) {
            return res.status(503).json({
              error: "UPI checkout is not configured. Add Merchant UPI ID in Settings (admin)."
            });
          }
        }

        const guestStatusIn =
          typeof bodyRaw.status === "string" && bodyRaw.status.trim()
            ? bodyRaw.status.trim().toUpperCase()
            : "NEW";
        const initialPosStatus =
          paymentMode === "upi" ? "new" : mapGuestPortalStatusToPos(guestStatusIn) || "new";

        const guestPaymentStatus: GuestPaymentStatus =
          paymentMode === "upi" ? "UPI_PENDING" : "PAY_AT_COUNTER";

        const newGuestOrder: Order = {
          id: nextOrderId(),
          storeId: storeIdMongo,
          tableId: resolvedGuestTable,
          items: guestItems.map((i) => ({
            ...i,
            kotLineId: i.kotLineId || newLineId(),
            lineStatus: "new"
          })),
          status: initialPosStatus,
          createdAt: new Date().toISOString(),
          isPaid: paymentMode === "upi" ? false : false,
          customerName: nameGuest,
          customerMobile: phoneGuest,
          guestPaymentStatus,
          ...(clientRid
            ? { lastClientRequestId: clientRid, lastClientRequestAt: new Date().toISOString() }
            : {})
        };
        orders.push(newGuestOrder);
        notifyOrderCreated({
          orderId: newGuestOrder.id,
          tableId: newGuestOrder.tableId,
          storeId: newGuestOrder.storeId,
          source: "qr_guest"
        });
        kotDisplayPayload(newGuestOrder, newGuestOrder.items, false);
        touchOrders(paymentMode === "upi" ? "qr_guest_order_upi" : "qr_guest_order");

        if (isMongoQrLive()) {
          void insertQrOrder({
            posOrderId: newGuestOrder.id,
            storeId: storeIdMongo,
            table: tableGuest,
            tableId: resolvedGuestTable,
            customerName: nameGuest,
            phone: phoneGuest,
            items: itemsRaw as unknown[],
            total: calcGuestTotal,
            status: guestStatusIn,
            createdAt: new Date()
          }).catch((e) => console.error("[mongo] insert qr order:", e));
          void upsertQrCustomer(nameGuest, phoneGuest).catch((e) => console.error("[mongo] upsert customer:", e));
        }

        const payee = (appSettings.merchantUpiPayeeName || appSettings.companyName || "Cafe").trim();
        const upiPayUrl =
          paymentMode === "upi"
            ? buildUpiIntentUrl(appSettings.merchantUpiVpa.trim(), payee, calcGuestTotal)
            : undefined;

        return res.status(201).json({
          id: newGuestOrder.id,
          table: tableGuest,
          tableId: newGuestOrder.tableId,
          storeId: storeIdMongo,
          customerName: nameGuest,
          phone: phoneGuest,
          status: guestStatusIn,
          total: calcGuestTotal,
          items: newGuestOrder.items,
          guestPaymentStatus,
          paymentMode,
          ...(upiPayUrl ? { upiPayUrl } : {})
        });
      }

      /** Staff POS uses this public route with Bearer token — tenant must be set on the order for analytics & billing. */
      const staffStoreId =
        storeIdFromAuthorizationHeader(req.headers.authorization) ?? LEGACY_DEFAULT_STORE_ID;
      if (process.env.DEBUG_STORE_ID === "1" || process.env.DEBUG_STORE_ID === "true") {
        console.log("[POST /orders] POS order storeId=%s (from JWT Bearer)", staffStoreId);
      }

      const {
        tableId,
        items,
        customerName,
        customerMobile,
        customerAddress,
        customerLocality,
        clientRequestId,
        waiterId: waiterIdInput
      } = req.body as {
        tableId?: string;
        items?: OrderItem[];
        customerName?: string;
        customerMobile?: string;
        customerAddress?: string;
        customerLocality?: string;
        clientRequestId?: string;
        /** Staff id from POS — resolved to name; omit to leave unchanged on merge */
        waiterId?: string | null;
      };

      if (!tableId || !Array.isArray(items) || items.length === 0) {
        return res
          .status(400)
          .json({ error: "tableId and at least one item are required" });
      }

      const tableExists =
        menuTables().some((t) => t.id === tableId) ||
        tableId === "TAKEAWAY" ||
        tableId === "DELIVERY";
      if (!tableExists) {
        return res.status(400).json({ error: "Unknown tableId" });
      }

      const rid = typeof clientRequestId === "string" && clientRequestId.trim() ? clientRequestId.trim() : "";
      if (rid) {
        const dup = orders.find((o) => o.lastClientRequestId === rid);
        if (dup) {
          return res.status(201).json({
            id: dup.id,
            tableId: dup.tableId,
            status: dup.status,
            total: calculateTotal(dup.items),
            idempotent: true,
            inventoryDeduction: { shortfalls: [] as InventoryDeductionResult["shortfalls"] }
          });
        }
      }

      const sanitizeItems = (raw: unknown): OrderItem[] => {
        if (!Array.isArray(raw)) return [];
        const out: OrderItem[] = [];
        for (const row of raw) {
          if (!row || typeof row !== "object") continue;
          const i = row as Record<string, unknown>;
          const id = i.id != null ? String(i.id).trim() : "";
          if (!id) continue;
          const qty = Math.max(1, Math.floor(Number(i.qty) || 1));
          const price = Math.max(0, Number(i.price) || 0);
          const name = typeof i.name === "string" && i.name.trim() ? i.name.trim() : "Item";
          const mods = Array.isArray(i.modifiers) ? (i.modifiers as string[]) : undefined;
          const spec =
            typeof i.specialInstructions === "string" && i.specialInstructions.trim()
              ? i.specialInstructions.trim()
              : undefined;
          out.push(
            normalizeItem({
              id,
              name,
              price,
              qty,
              category: typeof i.category === "string" ? i.category : undefined,
              type: i.type === "veg" || i.type === "non_veg" || i.type === "egg" ? i.type : undefined,
              sku: typeof i.sku === "string" ? i.sku : undefined,
              imageUrl: typeof i.imageUrl === "string" ? i.imageUrl : undefined,
              modifiers: mods,
              specialInstructions: spec,
              kotLineId: typeof i.kotLineId === "string" ? i.kotLineId : undefined,
              lineStatus:
                i.lineStatus === "cooking" || i.lineStatus === "ready" || i.lineStatus === "new"
                  ? i.lineStatus
                  : undefined
            })
          );
        }
        return out;
      };

      const orderItems = sanitizeItems(items);
      if (orderItems.length === 0) {
        return res.status(400).json({ error: "Each item needs a valid id and quantity" });
      }

      for (const it of orderItems) {
        const p = menuProducts().find((x) => x.id === it.id);
        if (!p || p.archived) {
          return res.status(400).json({
            error: `Item unavailable: ${it.name || it.id}`,
            code: "ITEM_UNAVAILABLE",
            productId: it.id
          });
        }
      }

      // Smart reorder: merge into an existing open order for the table
      const existing = orders
        .slice()
        .reverse()
        .find(
          (o) =>
            o.tableId === tableId &&
            !o.isPaid &&
            o.status !== "completed" &&
            o.status !== "cancelled"
        );

      if (existing) {
        if (!existing.storeId) existing.storeId = staffStoreId;
        if (!Array.isArray(existing.items)) existing.items = [];
        if (waiterIdInput !== undefined) {
          if (typeof waiterIdInput === "string" && waiterIdInput.trim()) {
            staffList = loadStaff();
            const ws = staffList.find((x) => x.id === waiterIdInput.trim());
            if (!ws) {
              return res.status(400).json({ error: "Invalid waiterId — use a staff member from Settings → Staff" });
            }
            existing.waiterId = ws.id;
            existing.waiterName = ws.name;
          } else {
            existing.waiterId = undefined;
            existing.waiterName = undefined;
          }
        }
        let addedNewLines = false;
        const mergedNewLines: OrderItem[] = [];
        for (const inc of orderItems) {
          const key = itemMergeKey(inc);
          const match = existing.items.find((ei) => itemMergeKey(ei) === key);
          if (match) {
            match.qty += inc.qty;
          } else {
            addedNewLines = true;
            const pushed: OrderItem = {
              ...inc,
              kotLineId: inc.kotLineId || newLineId(),
              lineStatus: "new",
              isNewlyAdded: true
            };
            existing.items.push(pushed);
            mergedNewLines.push(pushed);
          }
        }
        existing.isUpdated = true;
        if (rid) {
          existing.lastClientRequestId = rid;
          existing.lastClientRequestAt = new Date().toISOString();
        }
        if (customerName !== undefined) existing.customerName = customerName || undefined;
        if (customerMobile !== undefined) existing.customerMobile = customerMobile || undefined;
        if (customerAddress !== undefined) existing.customerAddress = customerAddress || undefined;
        if (customerLocality !== undefined) existing.customerLocality = customerLocality || undefined;
        if (addedNewLines && (existing.status === "ready" || existing.status === "served")) {
          existing.status = "cooking";
          existing.servedAt = undefined;
        }
        touchOrders("order_merge");
        if (addedNewLines && mergedNewLines.length > 0) {
          kotDisplayPayload(existing, mergedNewLines, true);
          notifyKotUpdated({ orderId: existing.id, tableId: existing.tableId, source: "pos_merge" });
        }
        return res.status(201).json({
          id: existing.id,
          tableId: existing.tableId,
          status: existing.status,
          total: orderInvoiceGrandTotal(existing),
          inventoryDeduction: { shortfalls: [] },
          merged: true
        });
      }

      let newWaiterId: string | undefined;
      let newWaiterName: string | undefined;
      if (waiterIdInput !== undefined) {
        if (typeof waiterIdInput === "string" && waiterIdInput.trim()) {
          staffList = loadStaff();
          const ws = staffList.find((x) => x.id === waiterIdInput.trim());
          if (!ws) {
            return res.status(400).json({ error: "Invalid waiterId — use a staff member from Settings → Staff" });
          }
          newWaiterId = ws.id;
          newWaiterName = ws.name;
        }
      }

      const newOrder: Order = {
        id: nextOrderId(),
        storeId: staffStoreId,
        tableId,
        items: orderItems.map((i) => ({
          ...i,
          kotLineId: i.kotLineId || newLineId(),
          lineStatus: i.lineStatus || "new"
        })),
        status: "new",
        createdAt: new Date().toISOString(),
        isPaid: false,
        customerName: customerName || undefined,
        customerMobile: customerMobile || undefined,
        customerAddress: customerAddress || undefined,
        customerLocality: customerLocality || undefined,
        ...(newWaiterId ? { waiterId: newWaiterId, waiterName: newWaiterName } : {}),
        ...(rid ? { lastClientRequestId: rid, lastClientRequestAt: new Date().toISOString() } : {})
      };

      orders.push(newOrder);
      notifyOrderCreated({
        orderId: newOrder.id,
        tableId: newOrder.tableId,
        source: "pos"
      });
      kotDisplayPayload(newOrder, newOrder.items, false);
      touchOrders("order_create");

      return res.status(201).json({
        id: newOrder.id,
        tableId: newOrder.tableId,
        status: newOrder.status,
        total: orderInvoiceGrandTotal(newOrder),
        inventoryDeduction: { shortfalls: [] }
      });
    } catch (err: unknown) {
      console.error("POST /orders failed:", err);
      const message = err instanceof Error ? err.message : "Internal error";
      return res.status(500).json({ error: message });
    }
  });

  /** Guest / kitchen display: update order status (no auth — use on trusted LAN or protect via gateway). */
  pub.patch("/orders/:id", (req: Request, res: Response) => {
    const orderId = (req.params.id || "").trim();
    const statusIn = (req.body as { status?: string })?.status;
    if (!orderId) return res.status(400).json({ error: "id required" });
    const nextPos =
      typeof statusIn === "string" && statusIn.trim() ? mapGuestPortalStatusToPos(statusIn.trim()) : null;
    if (!nextPos) {
      return res
        .status(400)
        .json({ error: "status must be NEW, PREPARING, READY, COMPLETED, or CANCELLED" });
    }
    const order = orders.find((o) => o.id === orderId);
    if (!order) return res.status(404).json({ error: "Order not found" });
    if (order.isPaid && nextPos !== "completed" && nextPos !== "cancelled") {
      return res.status(400).json({ error: "Paid orders cannot change kitchen status here" });
    }
    if (!canTransitionOrderStatus(order.status, nextPos)) {
      return res.status(400).json({ error: `Cannot go from ${order.status} to ${nextPos}` });
    }
    order.status = nextPos;
    if (nextPos === "cooking" && !order.cookingAt) order.cookingAt = new Date().toISOString();
    if (nextPos === "ready" && !order.readyAt) order.readyAt = new Date().toISOString();
    if (nextPos === "served" && !order.servedAt) order.servedAt = new Date().toISOString();
    touchOrders("patch_status");
    const portalLabel = mapPosStatusToGuestPortal(nextPos);
    void updateQrOrderStatus(orderId, portalLabel).catch((e) => console.error("[mongo] patch qr order:", e));
    res.json({ id: orderId, status: portalLabel });
  });

  /** QR customer: remove one line that is still "new" (not yet in kitchen). */
  pub.delete("/customer/orders/:orderId/lines/:kotLineId", (req: Request, res: Response) => {
    const orderId = (req.params.orderId || "").trim();
    const kotLineId = (req.params.kotLineId || "").trim();
    const tableId = typeof req.query.tableId === "string" ? req.query.tableId.trim() : "";
    if (!orderId || !kotLineId) return res.status(400).json({ error: "orderId and kotLineId required" });
    if (!tableId) return res.status(400).json({ error: "tableId query parameter required" });
    if (!menuTables().some((t) => t.id === tableId)) {
      return res.status(400).json({ error: "Unknown table" });
    }
    const order = orders.find((o) => o.id === orderId);
    if (!order || order.tableId !== tableId) {
      return res.status(404).json({ error: "Order not found" });
    }
    if (order.isPaid || order.status === "completed" || order.status === "cancelled") {
      return res.status(400).json({ error: "This bill cannot be changed from here" });
    }
    const idx = order.items.findIndex((i) => i.kotLineId === kotLineId);
    if (idx < 0) return res.status(404).json({ error: "Line not found" });
    const line = order.items[idx];
    if (line.lineStatus !== "new") {
      return res.status(400).json({
        error: "This item is already being prepared. Ask staff if you need to change it."
      });
    }
    order.items.splice(idx, 1);
    if (order.items.length === 0) {
      order.status = "cancelled";
    }
    order.isUpdated = true;
    touchOrders("customer_line_cancel");
    res.json({
      ok: true,
      total: orderInvoiceGrandTotal(order),
      itemsRemaining: order.items.length,
      orderStatus: order.status
    });
  });

  function kotWaiterDisplayForList(o: Order): { waiterId?: string; waiterName?: string } {
    staffList = loadStaff();
    const waiterId = typeof o.waiterId === "string" && o.waiterId.trim() ? o.waiterId.trim() : undefined;
    let waiterName =
      typeof o.waiterName === "string" && o.waiterName.trim() ? o.waiterName.trim() : undefined;
    if (waiterId) {
      const s = staffList.find((e) => e.id === waiterId);
      if (s?.name) waiterName = s.name;
    }
    return { waiterId, waiterName };
  }

  function mapOrderToKotListDto(o: Order, floor: FloorPlan) {
    const kotNo = parseInt(o.id.replace(/\D/g, ""), 10) || 0;
    const tableNo = o.tableId.replace(/\D/g, "") || o.tableId;
    const table = floor.tables.find((t) => t.id === o.tableId);
    const tableName =
      o.tableId === "DELIVERY"
        ? "Delivery"
        : o.tableId === "TAKEAWAY"
          ? "Takeaway"
          : table?.name?.trim()
            ? table.name.trim()
            : o.tableId;
    const section =
      o.tableId === "DELIVERY"
        ? "Delivery"
        : o.tableId === "TAKEAWAY"
          ? "Pick Up"
          : table
            ? sectionNameById(floor, table.sectionId)
            : "Other";
    const orderType =
      o.tableId === "DELIVERY" ? "delivery" : o.tableId === "TAKEAWAY" ? "takeaway" : "dine_in";
    const subtotal = orderItemsSubtotal(o);
    const billDiscount = billDiscountApplied(o);
    return {
      id: o.id,
      kotNo,
      tableId: o.tableId,
      tableNo,
      tableName,
      section,
      orderType,
      status: o.status,
      isPaid: o.isPaid,
      subtotal,
      billDiscount,
      total: orderInvoiceGrandTotal(o),
      createdAt: o.createdAt,
      cookingAt: o.cookingAt,
      readyAt: o.readyAt,
      servedAt: o.servedAt,
      isUpdated: o.isUpdated === true,
      customerName: o.customerName,
      customerMobile: o.customerMobile,
      customerAddress: o.customerAddress,
      customerLocality: o.customerLocality,
      guestPaymentStatus: o.guestPaymentStatus,
      ...kotWaiterDisplayForList(o),
      items: o.items.map((it) => ({
        ...it,
        specialInstructions: it.specialInstructions || "",
        modifiers: it.modifiers || []
      }))
    };
  }

  // Kitchen Order Tickets — public poll when `tableId` is set (QR ordering); else falls through to staff route.
  pub.get("/kots", (req: Request, res: Response, next: NextFunction) => {
    const tableId = typeof req.query.tableId === "string" ? req.query.tableId.trim() : "";
    if (!tableId) return next();
    const tableOk = menuTables().some((t) => t.id === tableId);
    if (!tableOk) {
      return res.status(404).json({ error: "Unknown table" });
    }
    const activeOnly = req.query.active !== "false";
    const floor = menuFloorPlan();
    const list = orders.filter((o) => {
      if (o.tableId !== tableId) return false;
      if (!orderVisibleOnKitchenBoard(o)) return false;
      if (activeOnly && (o.isPaid || o.status === "completed" || o.status === "cancelled")) return false;
      return true;
    });
    return res.json(list.map((o) => mapOrderToKotListDto(o, floor)));
  });

  /** Unauthenticated kitchen TV (`/kitchen`) — same active set as staff GET /kots?active=true. */
  pub.get("/kitchen-display/orders", (_req: Request, res: Response) => {
    const active = orders.filter(
      (o) =>
        orderVisibleOnKitchenBoard(o) &&
        !o.isPaid &&
        o.status !== "completed" &&
        o.status !== "cancelled"
    );
    const rows = active
      .slice()
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .map((o) => ({
        billNo: o.id,
        tableNo: tableLabelForGuestBill(o),
        items: o.items.map((i) => ({ name: i.name, quantity: i.qty })),
        timestamp: o.createdAt,
        orderId: o.id,
        merged: false as boolean
      }));
    res.json(rows);
  });

  // Kitchen Order Tickets (KOT) listing — active list or history + analytics (staff)
  prot.get("/kots", (req: Request, res: Response) => {
    const activeOnly = req.query.active !== "false";
    const range = typeof req.query.range === "string" ? req.query.range : "";
    const rangeKey = range === "today" || range === "7d" ? range : "";
    const dateRaw = typeof req.query.date === "string" ? req.query.date.trim() : "";
    const dateYmd = /^\d{4}-\d{2}-\d{2}$/.test(dateRaw) ? dateRaw : "";
    const fromRaw = typeof req.query.from === "string" ? req.query.from.trim() : "";
    const toRaw = typeof req.query.to === "string" ? req.query.to.trim() : "";

    const floor = menuFloorPlan();
    const mapOrder = (o: Order) => mapOrderToKotListDto(o, floor);

    if (activeOnly) {
      const list = orders.filter(
        (o) =>
          orderVisibleOnKitchenBoard(o) &&
          !o.isPaid &&
          o.status !== "completed" &&
          o.status !== "cancelled"
      );
      return res.json(list.map(mapOrder));
    }

    let hist = orders.filter(
      (o) => o.isPaid || o.status === "completed" || o.status === "cancelled"
    );
    const fromMs = fromRaw ? new Date(fromRaw).getTime() : NaN;
    const toMs = toRaw ? new Date(toRaw).getTime() : NaN;
    if (fromRaw && toRaw && Number.isFinite(fromMs) && Number.isFinite(toMs)) {
      hist = hist.filter((o) => {
        const t = new Date(o.createdAt).getTime();
        return Number.isFinite(t) && t >= fromMs && t <= toMs;
      });
    } else if (dateYmd) {
      hist = hist.filter((o) => kotOnLocalCalendarDay(o.createdAt, dateYmd));
    } else if (rangeKey) {
      hist = hist.filter((o) => kotInDateRange(o.createdAt, rangeKey));
    }
    const analytics = computeKotHistoryAnalytics(hist);
    res.json({
      kots: hist.map(mapOrder),
      analytics,
      range: dateYmd ? `day:${dateYmd}` : rangeKey || "all",
      date: dateYmd || undefined
    });
  });

  pub.get("/kots/:id", (req: Request, res: Response) => {
    const order = orders.find((o) => o.id === req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found" });
    const floor = menuFloorPlan();
    const table = floor.tables.find((t) => t.id === order.tableId);
    const tableNo = order.tableId.replace(/\D/g, "") || order.tableId;
    const section =
      order.tableId === "DELIVERY"
        ? "Delivery"
        : order.tableId === "TAKEAWAY"
          ? "Pick Up"
          : table
            ? sectionNameById(floor, table.sectionId)
            : "Other";
    const items = order.items.map((it) => ({
      ...it,
      specialInstructions: it.specialInstructions || "",
      modifiers: it.modifiers || []
    }));
    const orderType =
      order.tableId === "DELIVERY" ? "delivery" : order.tableId === "TAKEAWAY" ? "takeaway" : "dine_in";
    staffList = loadStaff();
    const waiterId = typeof order.waiterId === "string" && order.waiterId.trim() ? order.waiterId.trim() : undefined;
    let waiterName =
      typeof order.waiterName === "string" && order.waiterName.trim() ? order.waiterName.trim() : undefined;
    if (waiterId) {
      const s = staffList.find((e) => e.id === waiterId);
      if (s?.name) waiterName = s.name;
    }
    const tableName =
      order.tableId === "DELIVERY"
        ? "Delivery"
        : order.tableId === "TAKEAWAY"
          ? "Takeaway"
          : table?.name?.trim()
            ? table.name.trim()
            : order.tableId;
    const subtotal = orderItemsSubtotal(order);
    const billDiscount = billDiscountApplied(order);
    res.json({
      id: order.id,
      tableId: order.tableId,
      tableNo,
      tableName,
      section,
      orderType,
      status: order.status,
      isPaid: order.isPaid,
      subtotal,
      billDiscount,
      total: orderInvoiceGrandTotal(order),
      createdAt: order.createdAt,
      cookingAt: order.cookingAt,
      readyAt: order.readyAt,
      servedAt: order.servedAt,
      isUpdated: order.isUpdated === true,
      customerName: order.customerName,
      customerMobile: order.customerMobile,
      customerAddress: order.customerAddress,
      customerLocality: order.customerLocality,
      waiterId,
      waiterName,
      items
    });
  });

  // Update KOT status: new → cooking → ready → served → completed (or cancelled)
  prot.patch("/kots/:id/status", (req: Request, res: Response) => {
    const id = req.params.id;
    const { status } = req.body as { status?: OrderStatus };

    const order = orders.find((o) => o.id === id);
    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }

    if (!status) {
      return res.status(400).json({ error: "status is required" });
    }

    if (!canTransitionOrderStatus(order.status, status)) {
      return res.status(400).json({
        error: `Invalid status transition: ${order.status} → ${status}`
      });
    }

    const now = new Date().toISOString();
    if (status === "cooking") order.cookingAt = order.cookingAt || now;
    if (status === "ready") order.readyAt = order.readyAt || now;
    if (status === "served") order.servedAt = order.servedAt || now;

    order.status = status;
    touchOrders("kot_status");
    if (status === "completed") {
      tryCreateGuestBill(order);
    }
    res.json({
      id: order.id,
      tableId: order.tableId,
      status: order.status,
      isPaid: order.isPaid,
      total: orderInvoiceGrandTotal(order),
      cookingAt: order.cookingAt,
      readyAt: order.readyAt,
      servedAt: order.servedAt
    });
  });

  prot.patch("/kots/:id/items/:kotLineId", (req: Request, res: Response) => {
    const { id, kotLineId } = req.params;
    const { lineStatus } = req.body as { lineStatus?: OrderItemLineStatus };

    const order = orders.find((o) => o.id === id);
    if (!order) return res.status(404).json({ error: "Order not found" });
    if (order.status === "cancelled" || order.status === "completed") {
      return res.status(400).json({ error: "Order is closed" });
    }

    const line = order.items.find((i) => i.kotLineId === kotLineId);
    if (!line) return res.status(404).json({ error: "Line not found" });

    if (!lineStatus) {
      return res.status(400).json({ error: "lineStatus is required" });
    }
    if (!canTransitionLineStatus(line.lineStatus, lineStatus)) {
      return res.status(400).json({
        error: `Invalid line transition: ${line.lineStatus} → ${lineStatus}`
      });
    }

    const dishName = line.name;
    line.lineStatus = lineStatus;
    syncAllItemsReadyToOrderStatus(order);
    touchOrders("kot_item_status");
    try {
      const label = orderTableLabelForNotification(order);
      const short = `${order.id} · ${label}`;
      if (lineStatus === "cooking") {
        broadcastPosOrderNotification(
          order,
          "kot_line_cooking",
          "Dish in the kitchen",
          `${dishName} — ${short}`,
          ["kitchen", "all_staff"]
        );
      }
      if (lineStatus === "ready") {
        const allReady = order.items.every((i) => i.lineStatus === "ready");
        if (allReady) {
          broadcastPosOrderNotification(
            order,
            "kot_all_ready",
            "Full order ready",
            `All items ready — ${short}. Collect from pass.`,
            ["service", "customer", "all_staff"]
          );
        } else {
          broadcastPosOrderNotification(
            order,
            "kot_line_ready",
            "Dish ready",
            `${dishName} ready — ${short}`,
            ["service", "all_staff"]
          );
        }
      }
    } catch (_) {
      /* non-fatal */
    }
    res.json({
      id: order.id,
      tableId: order.tableId,
      status: order.status,
      readyAt: order.readyAt,
      items: order.items
    });
  });

  /** Staff: log client actions (e.g. bill printed) so customers / floor get notified. */
  prot.post("/orders/:orderId/notify-activity", (req: Request, res: Response) => {
    const orderId = (req.params.orderId || "").trim();
    const { action } = req.body as { action?: string };
    const order = orders.find((o) => o.id === orderId);
    if (!order) return res.status(404).json({ error: "Order not found" });
    if (action === "bill_printed") {
      const label = orderTableLabelForNotification(order);
      const total = orderInvoiceGrandTotal(order);
      const sym = appSettings.currencySymbol || "₹";
      broadcastPosOrderNotification(
        order,
        "bill_printed",
        "Bill printed",
        `Invoice ${order.id} · ${label} · ${sym}${total.toFixed(2)}`,
        ["billing", "service", "customer", "all_staff"]
      );
    }
    return res.json({ ok: true });
  });

  /** Staff: in-memory order store (same source as KOT). */
  prot.get("/orders", (_req: Request, res: Response) => {
    res.json(orders);
  });

  prot.get("/pos-notifications", (_req: Request, res: Response) => {
    res.json(listPosNotifications(100));
  });

  /** Assign or clear serving waiter (kitchen can set who picks up the pass). */
  prot.patch("/kots/:id/waiter", (req: Request, res: Response) => {
    const id = req.params.id;
    const { waiterId: widIn } = req.body as { waiterId?: string | null };
    const order = orders.find((o) => o.id === id);
    if (!order) return res.status(404).json({ error: "Order not found" });
    if (order.isPaid || order.status === "cancelled" || order.status === "completed") {
      return res.status(400).json({ error: "Order is closed" });
    }
    if (widIn === undefined) {
      return res.status(400).json({ error: "waiterId required (use empty string to clear)" });
    }
    if (widIn === null || (typeof widIn === "string" && !widIn.trim())) {
      order.waiterId = undefined;
      order.waiterName = undefined;
    } else {
      staffList = loadStaff();
      const ws = staffList.find((x) => x.id === String(widIn).trim());
      if (!ws) return res.status(400).json({ error: "Invalid waiterId — add staff under Staff" });
      order.waiterId = ws.id;
      order.waiterName = ws.name;
    }
    touchOrders("kot_waiter");
    res.json({
      id: order.id,
      waiterId: order.waiterId,
      waiterName: order.waiterName
    });
  });

  /** Staff: set manual bill discount (items subtotal − discount = amount before loyalty). */
  prot.patch("/kots/:id/billing", (req: Request, res: Response) => {
    const id = (req.params.id || "").trim();
    const { billDiscount: rawDisc } = req.body as { billDiscount?: unknown };
    const order = orders.find((o) => o.id === id);
    if (!order) return res.status(404).json({ error: "Order not found" });
    if (order.isPaid || order.status === "cancelled" || order.status === "completed") {
      return res.status(400).json({ error: "Order is closed" });
    }
    if (rawDisc === undefined || rawDisc === null) {
      return res.status(400).json({ error: "billDiscount required (number ≥ 0)" });
    }
    const n = typeof rawDisc === "number" ? rawDisc : parseFloat(String(rawDisc));
    if (!Number.isFinite(n) || n < 0) {
      return res.status(400).json({ error: "billDiscount must be a non-negative number" });
    }
    order.billDiscount = Math.round(n * 100) / 100;
    touchOrders("kot_billing");
    const subtotal = orderItemsSubtotal(order);
    const billDiscount = billDiscountApplied(order);
    res.json({
      id: order.id,
      subtotal,
      billDiscount,
      total: orderInvoiceGrandTotal(order)
    });
  });

  /** Attach customer phone/name on open KOT so billing & loyalty redemption work (e.g. typed on Confirm payment). */
  prot.patch("/kots/:id/customer", (req: Request, res: Response) => {
    const id = (req.params.id || "").trim();
    const body = req.body as { customerMobile?: unknown; customerName?: unknown };
    const order = orders.find((o) => o.id === id);
    if (!order) return res.status(404).json({ error: "Order not found" });
    if (order.isPaid || order.status === "cancelled" || order.status === "completed") {
      return res.status(400).json({ error: "Order is closed" });
    }
    if (body.customerMobile !== undefined) {
      const raw = typeof body.customerMobile === "string" ? body.customerMobile : String(body.customerMobile ?? "");
      const p = raw.replace(/\D/g, "");
      order.customerMobile = p.length >= 10 ? p : undefined;
    }
    if (body.customerName !== undefined) {
      const n = typeof body.customerName === "string" ? body.customerName.trim() : "";
      order.customerName = n || undefined;
    }
    touchOrders("kot_customer");
    res.json({
      id: order.id,
      customerMobile: order.customerMobile,
      customerName: order.customerName
    });
  });

  /**
   * Staff billing: UPI deep link for the amount shown on the bill (for QR display before recording payment).
   * Requires merchant UPI VPA in Settings (admin).
   */
  prot.get("/billing/upi-pay-url", (req: Request, res: Response) => {
    try {
      const raw = req.query.amount;
      const amount = typeof raw === "string" ? parseFloat(raw) : Number(raw);
      if (!Number.isFinite(amount) || amount <= 0) {
        return res.status(400).json({ error: "Valid amount required" });
      }
      const orderId = typeof req.query.orderId === "string" ? req.query.orderId.trim() : "";
      let sid = LEGACY_DEFAULT_STORE_ID;
      try {
        sid = getPosScope().storeId;
      } catch {
        /* */
      }
      if (orderId) {
        const order = orders.find((o) => o.id === orderId);
        if (!order) return res.status(404).json({ error: "Order not found" });
        if ((order.storeId || LEGACY_DEFAULT_STORE_ID) !== sid) {
          return res.status(404).json({ error: "Order not found" });
        }
      }
      appSettings = loadSettings();
      const vpa = appSettings.merchantUpiVpa.trim();
      if (!vpa || !isValidUpiVpa(vpa)) {
        return res.status(400).json({ error: "Merchant UPI ID not configured in Settings" });
      }
      const payee = (appSettings.merchantUpiPayeeName || appSettings.companyName || "Merchant").trim();
      const upiPayUrl = buildUpiIntentUrl(vpa, payee, amount);
      res.json({ upiPayUrl });
    } catch (e) {
      console.error("[billing/upi-pay-url]", e);
      res.status(500).json({ error: "Server error" });
    }
  });

  // Record a payment and mark order as paid.
  prot.post("/payments", (req: Request, res: Response) => {
    const { orderId, method, amount, redeemPoints, staffId, clientPaymentId } = req.body as {
      orderId?: string;
      method?: Payment["method"];
      amount?: number;
      redeemPoints?: number;
      staffId?: string;
      clientPaymentId?: string;
    };

    if (!orderId || !method || typeof amount !== "number") {
      return res
        .status(400)
        .json({ error: "orderId, method and amount are required" });
    }

    const payKey = typeof clientPaymentId === "string" && clientPaymentId.trim() ? clientPaymentId.trim() : "";
    if (payKey) {
      const existingPay = payments.find(
        (p) => p.orderId === orderId && p.clientIdempotencyKey === payKey
      );
      if (existingPay) {
        const o = orders.find((x) => x.id === orderId);
        const expectedTotal = o ? orderInvoiceGrandTotal(o) : amount;
        return res.status(201).json({
          receiptId: existingPay.id,
          orderId,
          tableId: o?.tableId,
          method: existingPay.method,
          amountPaid: existingPay.amount,
          items: o?.items,
          total: expectedTotal,
          paidAt: existingPay.createdAt,
          idempotent: true
        });
      }
    }

    const order = orders.find((o) => o.id === orderId);
    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }

    const expectedTotal = orderInvoiceGrandTotal(order);
    let discountFromLoyalty = 0;

    if (redeemPoints && redeemPoints > 0) {
      const p = (order.customerMobile || "").replace(/\D/g, "");
      if (p.length < 10) return res.status(400).json({ error: "Customer phone required to redeem points" });
      const ld = loadLoyaltyData();
      const acc = ld.accounts[p] ?? { phone: p, points: 0 };
      const priorVisits = effectivePaidVisitCount(acc, p, ld);
      const nextVisitNum = priorVisits + 1;
      const cycleLen = appSettings.loyaltyRedeemVisitCycleLength ?? 0;
      const activeCt = appSettings.loyaltyRedeemVisitActiveCount ?? 6;
      if (!loyaltyRedeemVisitRuleAllows(nextVisitNum, cycleLen, activeCt)) {
        const nextAllowed = nextVisitWhereRedeemAllowed(nextVisitNum + 1, cycleLen, activeCt);
        return res.status(400).json({
          error: `Loyalty redemption is not available on this visit (visit ${nextVisitNum}). Next discount visit: ${nextAllowed}.`
        });
      }
      if ((acc.points || 0) < redeemPoints) return res.status(400).json({ error: "Insufficient loyalty points" });
      const rp = appSettings.loyaltyRedeemPer100Points ?? 10;
      discountFromLoyalty = (redeemPoints / 100) * rp;
      const payAmount = Math.round((expectedTotal - discountFromLoyalty) * 100) / 100;
      if (Math.abs(amount - payAmount) > 0.01) return res.status(400).json({ error: `Amount must be ${payAmount} (total minus ${discountFromLoyalty} loyalty discount)` });
      acc.points = (acc.points || 0) - redeemPoints;
      ld.accounts[p] = acc;
      ld.transactions.push({ phone: p, type: "redeem", points: -redeemPoints, orderId: order.id, amount: discountFromLoyalty, createdAt: new Date().toISOString() });
      saveLoyaltyData(ld);
    } else if (amount < expectedTotal) {
      return res.status(400).json({ error: "Amount is less than order total" });
    }

    try {
      finalizeSaleInventory(order);
    } catch (e) {
      console.error("[inventory] finalize sale (cash/card payment):", e);
      return res.status(500).json({ error: "Inventory update failed; payment not recorded" });
    }

    const payment: Payment = {
      id: `PAY${payments.length + 1}`,
      orderId,
      method,
      amount,
      staffId: staffId || undefined,
      createdAt: new Date().toISOString(),
      ...(payKey ? { clientIdempotencyKey: payKey } : {})
    };
    payments.push(payment);
    order.isPaid = true;
    if (order.status !== "cancelled") {
      order.status = "completed";
    }
    tryCreateGuestBill(order);

    recordMoneyTransaction({
      type: "sale",
      amount: payment.amount,
      payment_method: mapPaymentMethodToMoneyTx(payment.method),
      note: `Order ${orderId}${staffId ? ` · staff ${staffId}` : ""}${payKey ? ` · idem:${payKey.slice(0, 12)}` : ""}`
    });
    touchOrders("payment");
    void recordPosSaleToPostgres(order, mapPaymentMethodToMoneyTx(payment.method), payment.amount).catch((err) =>
      console.error("[ops/pg] record sale:", err instanceof Error ? err.message : err)
    );

    // Visit count + earn points when customer has phone
    const phone = (order.customerMobile || "").replace(/\D/g, "");
    if (phone.length >= 10) {
      const loyaltyData = loadLoyaltyData();
      const acc = loyaltyData.accounts[phone] ?? { phone, points: 0 };
      const prior = effectivePaidVisitCount(acc, phone, loyaltyData);
      acc.paidVisitCount = prior + 1;
      const ptsPer100 = appSettings.loyaltyPointsPer100 ?? 10;
      const ptsEarned = Math.floor((payment.amount / 100) * ptsPer100);
      if (ptsEarned > 0) {
        acc.points = (acc.points || 0) + ptsEarned;
        loyaltyData.transactions.push({ phone, type: "earn", points: ptsEarned, orderId: order.id, amount: expectedTotal, createdAt: payment.createdAt });
      }
      loyaltyData.accounts[phone] = acc;
      saveLoyaltyData(loyaltyData);
    }

    res.status(201).json({
      receiptId: payment.id,
      orderId: order.id,
      tableId: order.tableId,
      method: payment.method,
      amountPaid: payment.amount,
      items: order.items,
      total: expectedTotal,
      paidAt: payment.createdAt
    });
  });

  // Razorpay: config flag for frontend (show "Pay with UPI/Card" only when enabled)
  prot.get("/payments/razorpay-config", (_req: Request, res: Response) => {
    res.json({ enabled: !!razorpayInstance });
  });

  // Razorpay: create order for online payment (UPI/Card)
  prot.post("/payments/create-razorpay-order", async (req: Request, res: Response) => {
    if (!razorpayInstance) {
      return res.status(503).json({ error: "Razorpay not configured. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET." });
    }
    const { orderId, amount: amountRupees, redeemPoints } = req.body as { orderId?: string; amount?: number; redeemPoints?: number };
    if (!orderId || typeof amountRupees !== "number" || amountRupees < 0) {
      return res.status(400).json({ error: "orderId and amount (in rupees) required" });
    }
    const order = orders.find((o) => o.id === orderId);
    if (!order) return res.status(404).json({ error: "Order not found" });
    if (order.isPaid) return res.status(400).json({ error: "Order already paid" });
    const expectedTotal = orderInvoiceGrandTotal(order);
    let payableAmount = amountRupees;
    if (redeemPoints && redeemPoints > 0) {
      const p = (order.customerMobile || "").replace(/\D/g, "");
      if (p.length < 10) return res.status(400).json({ error: "Customer phone required to redeem points" });
      const ld = loadLoyaltyData();
      const acc = ld.accounts[p] ?? { phone: p, points: 0 };
      const priorVisits = effectivePaidVisitCount(acc, p, ld);
      const nextVisitNum = priorVisits + 1;
      const cycleLen = appSettings.loyaltyRedeemVisitCycleLength ?? 0;
      const activeCt = appSettings.loyaltyRedeemVisitActiveCount ?? 6;
      if (!loyaltyRedeemVisitRuleAllows(nextVisitNum, cycleLen, activeCt)) {
        const nextAllowed = nextVisitWhereRedeemAllowed(nextVisitNum + 1, cycleLen, activeCt);
        return res.status(400).json({
          error: `Loyalty redemption is not available on this visit (visit ${nextVisitNum}). Next discount visit: ${nextAllowed}.`
        });
      }
      if ((acc.points || 0) < redeemPoints) return res.status(400).json({ error: "Insufficient loyalty points" });
      const rp = appSettings.loyaltyRedeemPer100Points ?? 10;
      const discountFromLoyalty = (redeemPoints / 100) * rp;
      payableAmount = Math.round((expectedTotal - discountFromLoyalty) * 100) / 100;
    } else if (Math.abs(amountRupees - expectedTotal) > 0.01) {
      payableAmount = expectedTotal;
    }
    const amountPaise = Math.max(100, Math.round(payableAmount * 100));
    try {
      const razorpayOrder = await razorpayInstance.orders.create({
        amount: amountPaise,
        currency: "INR",
        receipt: orderId.slice(0, 40)
      });
      res.json({
        razorpayOrderId: razorpayOrder.id,
        keyId: RAZORPAY_KEY_ID,
        amount: razorpayOrder.amount,
        currency: razorpayOrder.currency || "INR"
      });
    } catch (e) {
      console.error("Razorpay create order failed", e);
      res.status(500).json({ error: "Failed to create payment order" });
    }
  });

  // Razorpay: verify signature and mark order paid
  prot.post("/payments/verify-razorpay", (req: Request, res: Response) => {
    const { orderId, razorpayPaymentId, razorpayOrderId, razorpaySignature } = req.body as {
      orderId?: string;
      razorpayPaymentId?: string;
      razorpayOrderId?: string;
      razorpaySignature?: string;
    };
    if (!orderId || !razorpayPaymentId || !razorpayOrderId || !razorpaySignature) {
      return res.status(400).json({ error: "orderId, razorpayPaymentId, razorpayOrderId, razorpaySignature required" });
    }
    const order = orders.find((o) => o.id === orderId);
    if (!order) return res.status(404).json({ error: "Order not found" });
    if (order.isPaid) {
      const prior = payments
        .filter((p) => p.orderId === orderId)
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
      return res.status(201).json({
        receiptId: prior?.id ?? "unknown",
        orderId: order.id,
        method: prior?.method ?? "upi",
        amountPaid: prior?.amount ?? orderInvoiceGrandTotal(order),
        paidAt: prior?.createdAt ?? order.createdAt,
        idempotent: true
      });
    }
    const expectedSig = crypto.createHmac("sha256", RAZORPAY_KEY_SECRET).update(`${razorpayOrderId}|${razorpayPaymentId}`).digest("hex");
    if (expectedSig !== razorpaySignature) {
      return res.status(400).json({ error: "Invalid payment signature" });
    }
    const amount = orderInvoiceGrandTotal(order);
    try {
      finalizeSaleInventory(order);
    } catch (e) {
      console.error("[inventory] finalize sale (Razorpay):", e);
      return res.status(500).json({ error: "Inventory update failed; payment not recorded" });
    }
    const payment: Payment = {
      id: `PAY${payments.length + 1}`,
      orderId,
      method: "upi",
      amount,
      staffId: (req.body as { staffId?: string }).staffId,
      createdAt: new Date().toISOString()
    };
    payments.push(payment);
    order.isPaid = true;
    if (order.status !== "cancelled") {
      order.status = "completed";
    }
    tryCreateGuestBill(order);

    recordMoneyTransaction({
      type: "sale",
      amount: payment.amount,
      payment_method: mapPaymentMethodToMoneyTx(payment.method),
      note: `Order ${orderId} · Razorpay ${razorpayPaymentId ?? ""}`.trim()
    });
    touchOrders("payment");
    void recordPosSaleToPostgres(order, mapPaymentMethodToMoneyTx(payment.method), payment.amount).catch((err) =>
      console.error("[ops/pg] record sale:", err instanceof Error ? err.message : err)
    );

    const phone = (order.customerMobile || "").replace(/\D/g, "");
    if (phone.length >= 10) {
      const loyaltyData = loadLoyaltyData();
      const acc = loyaltyData.accounts[phone] ?? { phone, points: 0 };
      const prior = effectivePaidVisitCount(acc, phone, loyaltyData);
      acc.paidVisitCount = prior + 1;
      const ptsPer100 = appSettings.loyaltyPointsPer100 ?? 10;
      const ptsEarned = Math.floor((payment.amount / 100) * ptsPer100);
      if (ptsEarned > 0) {
        acc.points = (acc.points || 0) + ptsEarned;
        loyaltyData.transactions.push({ phone, type: "earn", points: ptsEarned, orderId: order.id, amount, createdAt: payment.createdAt });
      }
      loyaltyData.accounts[phone] = acc;
      saveLoyaltyData(loyaltyData);
    }
    res.status(201).json({
      receiptId: payment.id,
      orderId: order.id,
      method: payment.method,
      amountPaid: payment.amount,
      paidAt: payment.createdAt
    });
  });

  // Loyalty Program
  type LoyaltyAccount = { phone: string; points: number; paidVisitCount?: number };
  type LoyaltyTx = { phone: string; type: "earn" | "redeem" | "spin"; points: number; orderId?: string; amount?: number; createdAt: string };
  type LoyaltyData = { accounts: Record<string, LoyaltyAccount>; transactions: LoyaltyTx[] };

  const SPIN_SEGMENTS = [10, 20, 50, 100, 0];
  const SPIN_WEIGHTS = [25, 30, 25, 10, 10];

  prot.post("/loyalty/spin", (req: Request, res: Response) => {
    const phone = (req.body?.phone as string)?.replace(/\D/g, "") ?? "";
    if (phone.length < 10) return res.status(400).json({ error: "Valid 10-digit phone required to spin" });
    let totalWeight = 0;
    for (const w of SPIN_WEIGHTS) totalWeight += w;
    let r = Math.random() * totalWeight;
    let segmentIndex = 0;
    for (let i = 0; i < SPIN_WEIGHTS.length; i++) {
      r -= SPIN_WEIGHTS[i];
      if (r <= 0) { segmentIndex = i; break; }
    }
    const prizePoints = SPIN_SEGMENTS[segmentIndex];
    const data = loadLoyaltyData();
    const acc = data.accounts[phone] ?? { phone, points: 0 };
    if (prizePoints > 0) {
      acc.points = (acc.points || 0) + prizePoints;
      data.accounts[phone] = acc;
      data.transactions.push({ phone, type: "spin", points: prizePoints, orderId: undefined, amount: undefined, createdAt: new Date().toISOString() });
      saveLoyaltyData(data);
    }
    res.json({ segmentIndex, prizePoints, newBalance: acc.points });
  });
  function loadLoyaltyData(): LoyaltyData {
    try {
      const data = fs.readFileSync(LOYALTY_FILE, "utf-8");
      const parsed = JSON.parse(data);
      return { accounts: parsed.accounts ?? {}, transactions: Array.isArray(parsed.transactions) ? parsed.transactions : [] };
    } catch {
      return { accounts: {}, transactions: [] };
    }
  }
  function saveLoyaltyData(d: LoyaltyData) {
    setImmediate(() => {
      try {
        fs.mkdirSync(path.dirname(LOYALTY_FILE), { recursive: true });
        writeJsonValueAtomicSync(LOYALTY_FILE, d);
      } catch (err) {
        console.error("Failed to save loyalty:", err);
      }
    });
  }

  prot.get("/loyalty", (req: Request, res: Response) => {
    appSettings = loadSettings();
    const phone = (req.query.phone as string)?.replace(/\D/g, "") ?? "";
    const redeemPer100 = appSettings.loyaltyRedeemPer100Points ?? 10;
    const cycleLen = appSettings.loyaltyRedeemVisitCycleLength ?? 0;
    const activeCt = appSettings.loyaltyRedeemVisitActiveCount ?? 6;
    if (phone.length < 10) {
      return res.json({
        points: 0,
        redeemValuePer100: redeemPer100,
        paidVisitCount: 0,
        nextVisitNumber: 1,
        redeemAllowedThisVisit: true,
        nextDiscountVisit: 1,
        loyaltyVisitMessage: "",
        loyaltyRedeemVisitCycleLength: cycleLen,
        loyaltyRedeemVisitActiveCount: activeCt
      });
    }
    const data = loadLoyaltyData();
    const acc = data.accounts[phone];
    const priorVisits = effectivePaidVisitCount(acc, phone, data);
    const nextVisitNumber = priorVisits + 1;
    const redeemAllowedThisVisit = loyaltyRedeemVisitRuleAllows(nextVisitNumber, cycleLen, activeCt);
    const nextDiscountVisit = redeemAllowedThisVisit
      ? nextVisitNumber
      : nextVisitWhereRedeemAllowed(nextVisitNumber + 1, cycleLen, activeCt);
    let loyaltyVisitMessage = "";
    if (cycleLen <= 0) {
      loyaltyVisitMessage = "Loyalty discount can be used on this bill when you have enough points.";
    } else if (redeemAllowedThisVisit) {
      loyaltyVisitMessage = `This bill is visit ${nextVisitNumber} — you can use loyalty discount (visits ${activeCt} of each ${cycleLen}-visit cycle).`;
    } else {
      loyaltyVisitMessage = `This bill is visit ${nextVisitNumber} — loyalty discount is not available. Next discount on visit ${nextDiscountVisit}.`;
    }
    res.json({
      points: acc?.points ?? 0,
      redeemValuePer100: redeemPer100,
      paidVisitCount: priorVisits,
      nextVisitNumber,
      redeemAllowedThisVisit,
      nextDiscountVisit,
      loyaltyVisitMessage,
      loyaltyRedeemVisitCycleLength: cycleLen,
      loyaltyRedeemVisitActiveCount: activeCt
    });
  });
  prot.get("/loyalty/calculate", (req: Request, res: Response) => {
    const points = Math.max(0, parseInt(String(req.query.points), 10) || 0);
    const redeemPer100 = appSettings.loyaltyRedeemPer100Points ?? 10;
    const discount = (points / 100) * redeemPer100;
    res.json({ points, discount });
  });
  prot.post("/loyalty/redeem", (req: Request, res: Response) => {
    const { phone: rawPhone, points: ptsToRedeem, orderId } = req.body as { phone?: string; points?: number; orderId?: string };
    const phone = (rawPhone || "").replace(/\D/g, "");
    if (phone.length < 10) return res.status(400).json({ error: "Valid phone required" });
    const points = Math.max(0, Math.floor(Number(ptsToRedeem) || 0));
    if (points === 0) return res.status(400).json({ error: "Points to redeem must be > 0" });
    const order = orderId ? orders.find((o) => o.id === orderId) : null;
    const orderTotal = order ? orderInvoiceGrandTotal(order) : 0;
    const redeemPer100 = appSettings.loyaltyRedeemPer100Points ?? 10;
    const discount = (points / 100) * redeemPer100;

    appSettings = loadSettings();
    const data = loadLoyaltyData();
    const acc = data.accounts[phone] ?? { phone, points: 0 };
    const priorVisits = effectivePaidVisitCount(acc, phone, data);
    const nextVisitNum = priorVisits + 1;
    const cycleLen = appSettings.loyaltyRedeemVisitCycleLength ?? 0;
    const activeCt = appSettings.loyaltyRedeemVisitActiveCount ?? 6;
    if (!loyaltyRedeemVisitRuleAllows(nextVisitNum, cycleLen, activeCt)) {
      const nextAllowed = nextVisitWhereRedeemAllowed(nextVisitNum + 1, cycleLen, activeCt);
      return res.status(400).json({
        error: `Loyalty redemption is not available on this visit (visit ${nextVisitNum}). Next discount visit: ${nextAllowed}.`
      });
    }
    if ((acc.points || 0) < points) return res.status(400).json({ error: "Insufficient points" });
    acc.points = (acc.points || 0) - points;
    data.accounts[phone] = acc;
    data.transactions.push({ phone, type: "redeem", points: -points, orderId, amount: discount, createdAt: new Date().toISOString() });
    saveLoyaltyData(data);

    res.json({ pointsRedeemed: points, discount, newBalance: acc.points });
  });
  prot.get("/loyalty/top", (_req: Request, res: Response) => {
    const data = loadLoyaltyData();
    const list = Object.values(data.accounts)
      .filter((a) => a.points > 0)
      .sort((a, b) => b.points - a.points)
      .slice(0, 50);
    res.json(list);
  });
  prot.get("/loyalty/transactions", (req: Request, res: Response) => {
    const phone = (req.query.phone as string)?.replace(/\D/g, "") ?? "";
    const data = loadLoyaltyData();
    const list = phone.length >= 10
      ? data.transactions.filter((t) => t.phone === phone).slice(-50).reverse()
      : data.transactions.slice(-100).reverse();
    res.json(list);
  });

  // Cash Flow: payments (in) + top-up/withdrawal
  prot.get("/cash-flow", (req: Request, res: Response) => {
    const dateStr = (req.query.date as string) || new Date().toISOString().slice(0, 10);
    const dayStart = new Date(dateStr);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(dateStr);
    dayEnd.setHours(23, 59, 59, 999);

    const dayPayments = payments.filter((p) => {
      const d = new Date(p.createdAt).getTime();
      return d >= dayStart.getTime() && d <= dayEnd.getTime();
    });
    const dayEntries = cashEntries.filter((e) => {
      const d = new Date(e.createdAt).getTime();
      return d >= dayStart.getTime() && d <= dayEnd.getTime();
    });

    const cashInSales = dayPayments.reduce((s, p) => s + p.amount, 0);
    const byMethod = { cash: 0, card: 0, upi: 0, qr: 0 };
    dayPayments.forEach((p) => { byMethod[p.method] = (byMethod[p.method] || 0) + p.amount; });
    const cashInTopup = dayEntries.filter((e) => e.type === "topup").reduce((s, e) => s + e.amount, 0);
    const cashOut = dayEntries.filter((e) => e.type === "withdrawal").reduce((s, e) => s + e.amount, 0);

    const movements = [
      ...dayPayments.map((p) => ({ id: p.id, type: "payment" as const, amount: p.amount, method: p.method, orderId: p.orderId, note: "Order payment", createdAt: p.createdAt })),
      ...dayEntries.map((e) => ({ id: e.id, type: e.type, amount: e.amount, note: e.note, createdAt: e.createdAt }))
    ].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    res.json({
      date: dateStr,
      cashInSales,
      cashInByMethod: byMethod,
      cashInTopup,
      cashOut,
      netCash: cashInSales + cashInTopup - cashOut,
      movements
    });
  });
  prot.post("/cash-flow/topup", (req: Request, res: Response) => {
    const { amount, note } = req.body as { amount?: number; note?: string };
    if (amount == null || amount <= 0) return res.status(400).json({ error: "amount required and must be > 0" });
    const e: CashEntry = { id: `CF${cashEntries.length + 1}`, type: "topup", amount, note, createdAt: new Date().toISOString() };
    cashEntries.push(e);
    recordMoneyTransaction({
      type: "deposit",
      amount,
      payment_method: "cash",
      note: note ? `Cash drawer top-up — ${note}` : "Cash drawer top-up"
    });
    res.status(201).json(e);
  });
  prot.post("/cash-flow/withdrawal", (req: Request, res: Response) => {
    const { amount, note } = req.body as { amount?: number; note?: string };
    if (amount == null || amount <= 0) return res.status(400).json({ error: "amount required and must be > 0" });
    const e: CashEntry = { id: `CF${cashEntries.length + 1}`, type: "withdrawal", amount, note, createdAt: new Date().toISOString() };
    cashEntries.push(e);
    recordMoneyTransaction({
      type: "withdrawal",
      amount,
      payment_method: "cash",
      note: note ? `Cash drawer withdrawal — ${note}` : "Cash drawer withdrawal"
    });
    res.status(201).json(e);
  });

  // Day End: summary for a date (sales, payments by method, expenses, cash flow), close day, list history
  function getDayEndSummary(dateStr: string) {
    const dayStart = new Date(dateStr); dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(dateStr); dayEnd.setHours(23, 59, 59, 999);
    const paid = orders.filter((o) => o.isPaid && new Date(o.createdAt).getTime() >= dayStart.getTime() && new Date(o.createdAt).getTime() <= dayEnd.getTime());
    const sales = paid.reduce((s, o) => s + calculateTotal(o.items), 0);
    const dayPurchases = purchases.filter((p) => new Date(p.createdAt).getTime() >= dayStart.getTime() && new Date(p.createdAt).getTime() <= dayEnd.getTime());
    const purchasesTotal = dayPurchases.reduce((s, p) => s + (p.cost ?? 0), 0);
    const dayExpenses = expenses.filter((e) => new Date(e.createdAt).getTime() >= dayStart.getTime() && new Date(e.createdAt).getTime() <= dayEnd.getTime());
    const expensesTotal = dayExpenses.reduce((s, e) => s + e.amount, 0);
    const dayPayments = payments.filter((p) => { const d = new Date(p.createdAt).getTime(); return d >= dayStart.getTime() && d <= dayEnd.getTime(); });
    const cashIn = dayPayments.reduce((s, p) => s + p.amount, 0);
    const dayEntries = cashEntries.filter((e) => { const d = new Date(e.createdAt).getTime(); return d >= dayStart.getTime() && d <= dayEnd.getTime(); });
    const topup = dayEntries.filter((e) => e.type === "topup").reduce((s, e) => s + e.amount, 0);
    const cashOut = dayEntries.filter((e) => e.type === "withdrawal").reduce((s, e) => s + e.amount, 0);
    const netCash = cashIn + topup - cashOut;
    const paymentsByMethod: Record<string, { count: number; amount: number }> = {};
    dayPayments.forEach((p) => {
      if (!paymentsByMethod[p.method]) paymentsByMethod[p.method] = { count: 0, amount: 0 };
      paymentsByMethod[p.method].count += 1;
      paymentsByMethod[p.method].amount += p.amount;
    });
    const paymentsList = dayPayments.map((p) => ({ id: p.id, orderId: p.orderId, method: p.method, amount: p.amount, createdAt: p.createdAt }));
    return { date: dateStr, sales, purchases: purchasesTotal, expenses: expensesTotal, cashIn: cashIn + topup, cashOut, netCash, orderCount: paid.length, paymentsByMethod, payments: paymentsList };
  }
  prot.get("/day-ends/summary", (req: Request, res: Response) => {
    const dateStr = (req.query.date as string) || new Date().toISOString().slice(0, 10);
    res.json(getDayEndSummary(dateStr));
  });
  prot.get("/reports/day-end", (req: Request, res: Response) => {
    const dateStr = (req.query.date as string) || new Date().toISOString().slice(0, 10);
    res.json(getDayEndSummary(dateStr));
  });
  prot.post("/day-ends", (req: Request, res: Response) => {
    const { date } = req.body as { date?: string };
    const dateStr = date || new Date().toISOString().slice(0, 10);
    const existing = dayEnds.find((d) => d.date === dateStr);
    if (existing) return res.status(400).json({ error: "Day already closed for this date" });
    const dayStart = new Date(dateStr); dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(dateStr); dayEnd.setHours(23, 59, 59, 999);
    const paid = orders.filter((o) => o.isPaid && new Date(o.createdAt).getTime() >= dayStart.getTime() && new Date(o.createdAt).getTime() <= dayEnd.getTime());
    const sales = paid.reduce((s, o) => s + calculateTotal(o.items), 0);
    const dayPurchases = purchases.filter((p) => new Date(p.createdAt).getTime() >= dayStart.getTime() && new Date(p.createdAt).getTime() <= dayEnd.getTime());
    const purchasesTotal = dayPurchases.reduce((s, p) => s + (p.cost ?? 0), 0);
    const dayExpenses = expenses.filter((e) => new Date(e.createdAt).getTime() >= dayStart.getTime() && new Date(e.createdAt).getTime() <= dayEnd.getTime());
    const expensesTotal = dayExpenses.reduce((s, e) => s + e.amount, 0);
    const dayPayments = payments.filter((p) => { const d = new Date(p.createdAt).getTime(); return d >= dayStart.getTime() && d <= dayEnd.getTime(); });
    const cashIn = dayPayments.reduce((s, p) => s + p.amount, 0);
    const dayEntries = cashEntries.filter((e) => { const d = new Date(e.createdAt).getTime(); return d >= dayStart.getTime() && d <= dayEnd.getTime(); });
    const topup = dayEntries.filter((e) => e.type === "topup").reduce((s, e) => s + e.amount, 0);
    const cashOut = dayEntries.filter((e) => e.type === "withdrawal").reduce((s, e) => s + e.amount, 0);
    const netCash = cashIn + topup - cashOut;
    const de: DayEnd = { id: `DE${dayEnds.length + 1}`, date: dateStr, sales, purchases: purchasesTotal, expenses: expensesTotal, cashIn: cashIn + topup, cashOut, netCash, orderCount: paid.length, closedAt: new Date().toISOString() };
    dayEnds.push(de);
    saveDayEnds(dayEnds);
    res.status(201).json(de);
  });
  prot.get("/day-ends", (_req: Request, res: Response) => {
    dayEnds = loadDayEnds();
    res.json(dayEnds.slice(-50).reverse());
  });

  // Feedback (suggestions, thanks, issues)
  type Feedback = {
    id: string;
    type: "suggestion" | "issue" | "thanks" | "other" | "checkout";
    message: string;
    rating?: number;
    createdAt: string;
  };
  const FEEDBACK_FILE = path.join(DATA_DIR, "feedback.json");
  function loadFeedback(): Feedback[] {
    try {
      const data = fs.readFileSync(FEEDBACK_FILE, "utf-8");
      const arr = JSON.parse(data);
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }
  function saveFeedback(list: Feedback[]) {
    setImmediate(() => {
      try {
        fs.mkdirSync(path.dirname(FEEDBACK_FILE), { recursive: true });
        writeJsonValueAtomicSync(FEEDBACK_FILE, list);
      } catch (err) {
        console.error("Failed to save feedback:", err);
      }
    });
  }
  let feedbackList: Feedback[] = loadFeedback();

  prot.get("/feedback", (_req: Request, res: Response) => {
    res.json(feedbackList.slice(-100).reverse());
  });
  prot.post("/feedback", (req: Request, res: Response) => {
    const { type, message, rating } = req.body as Partial<Feedback>;
    const msg = typeof message === "string" ? message.trim() : "";
    const hasRating = typeof rating === "number" && rating >= 1 && rating <= 5;
    if (!hasRating && (!msg || msg.length < 3)) {
      return res.status(400).json({ error: "Message (min 3 chars) or rating (1–5) required" });
    }
    const validType = type && ["suggestion", "issue", "thanks", "other", "checkout"].includes(type) ? type : (hasRating ? "checkout" : "other");
    const r: Feedback = {
      id: `FB${Date.now()}`,
      type: validType,
      message: msg || (hasRating ? `Checkout rating: ${Math.round(rating)}` : ""),
      rating: hasRating ? Math.round(rating) : undefined,
      createdAt: new Date().toISOString()
    };
    feedbackList.push(r);
    saveFeedback(feedbackList);
    res.status(201).json(r);
  });

  /** Compact KPIs: ledger sales, paid-order stats, ingredient low-stock count (real data only). */
  const handleDashboardSummary = (req: Request, res: Response, next: NextFunction) => {
    try {
      const rawDate = (req.query.date as string) || localYmdFromTimestamp(Date.now());
      const dateStr = typeof rawDate === "string" ? rawDate.trim() : localYmdFromTimestamp(Date.now());
      let dayStart: Date;
      let dayEnd: Date;
      let anchor: Date;
      if (CAL_YMD_RE.test(dateStr)) {
        const b = localDayBoundsFromYmd(dateStr);
        dayStart = b.start;
        dayEnd = b.end;
        anchor = dayStart;
      } else {
        const selected = new Date(dateStr);
        anchor = selected;
        dayStart = new Date(selected);
        dayStart.setHours(0, 0, 0, 0);
        dayEnd = new Date(selected);
        dayEnd.setHours(23, 59, 59, 999);
      }

      const dayLedger = aggregateMoneyLedgerRange(dayStart, dayEnd);
      const paid = orders.filter((o) => o.isPaid);
      const dayOrders = paid.filter((o) => {
        const d = new Date(o.createdAt).getTime();
        return d >= dayStart.getTime() && d <= dayEnd.getTime();
      });
      const totalSales = dayLedger.sales;
      const totalOrders = dayOrders.length;
      const revenueFromOrders = dayOrders.reduce((s, o) => s + calculateTotal(o.items), 0);
      const avgOrderValue = totalOrders > 0 ? revenueFromOrders / totalOrders : 0;
      const netProfit = dayLedger.net;
      const lowStockItems = menuIngredients().filter((i) => i.stock_quantity <= i.low_stock_threshold)
        .length;

      res.json({
        date: CAL_YMD_RE.test(dateStr) ? dateStr : localYmdFromTimestamp(anchor.getTime()),
        totalSales,
        totalOrders,
        avgOrderValue,
        netProfit,
        lowStockItems
      });
    } catch (e) {
      next(e);
    }
  };

  // Dashboard: unified P&amp;L from money ledger + orders for top items; inventory alerts from ingredients.
  const handlePosDashboard = (req: Request, res: Response, next: NextFunction) => {
    try {
      const rawDate = (req.query.date as string) || localYmdFromTimestamp(Date.now());
      const dateStr = typeof rawDate === "string" ? rawDate.trim() : localYmdFromTimestamp(Date.now());
      let dayStart: Date;
      let dayEnd: Date;
      let anchor: Date;
      if (CAL_YMD_RE.test(dateStr)) {
        const b = localDayBoundsFromYmd(dateStr);
        dayStart = b.start;
        dayEnd = b.end;
        anchor = dayStart;
      } else {
        const selected = new Date(dateStr);
        anchor = selected;
        dayStart = new Date(selected);
        dayStart.setHours(0, 0, 0, 0);
        dayEnd = new Date(selected);
        dayEnd.setHours(23, 59, 59, 999);
      }
      const monthStart = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
      const monthEnd = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0, 23, 59, 59, 999);

      const dayLedger = aggregateMoneyLedgerRange(dayStart, dayEnd);
      const monthLedger = aggregateMoneyLedgerRange(monthStart, monthEnd);

      const paid = orders.filter((o) => o.isPaid);
      const dayOrders = paid.filter((o) => {
        const d = new Date(o.createdAt).getTime();
        return d >= dayStart.getTime() && d <= dayEnd.getTime();
      });
      const todayRevenue = dayLedger.sales;
      const todayExpenses = dayLedger.expenses;
      const todayNetProfit = dayLedger.net;
      const monthRevenue = monthLedger.sales;
      const monthExpenses = monthLedger.expenses;
      const monthNetProfit = monthLedger.net;

      const dayPurchases = purchases.filter((p) => {
        const d = new Date(p.createdAt).getTime();
        return d >= dayStart.getTime() && d <= dayEnd.getTime();
      });
      const monthPurchases = purchases.filter((p) => {
        const d = new Date(p.createdAt).getTime();
        return d >= monthStart.getTime() && d <= monthEnd.getTime();
      });
      const todayPurchase = dayPurchases.reduce((s, p) => s + (p.cost ?? 0), 0);
      const monthPurchase = monthPurchases.reduce((s, p) => s + (p.cost ?? 0), 0);

      const recentSales = dayOrders
        .slice()
        .reverse()
        .slice(0, 10)
        .map((o) => ({
          id: o.id,
          tableId: o.tableId,
          total: calculateTotal(o.items),
          createdAt: o.createdAt
        }));

      const ingLow = menuIngredients().filter((i) => i.stock_quantity <= i.low_stock_threshold);
      const ingOut = menuIngredients().filter((i) => i.stock_quantity <= 0);
      const ingHealthy = menuIngredients().filter((i) => i.stock_quantity > i.low_stock_threshold);
      const inventorySnapshot = {
        healthy: ingHealthy.length,
        lowStock: ingLow.length,
        outOfStock: ingOut.length
      };

      const lowStockAlerts = buildLowStockIngredientAlerts(12);
      const topItemsToday = topSellingItemsFromOrders(dayStart, dayEnd, 8);
      const runoutAlerts = buildInventoryRunoutAlerts();

      res.json({
        date: CAL_YMD_RE.test(dateStr) ? dateStr : localYmdFromTimestamp(anchor.getTime()),
        todayRevenue,
        todayExpenses,
        todayNetProfit,
        monthRevenue,
        monthExpenses,
        monthNetProfit,
        todayPurchase,
        monthPurchase,
        recentSales,
        inventorySnapshot,
        lowStockAlerts,
        topItemsToday,
        runoutAlerts,
        runoutLookbackDays: INVENTORY_RUNOUT_LOOKBACK_DAYS,
        dataNote:
          "Sales & expenses from money ledger (POS payments + recorded expenses). Purchases with cost create expenses."
      });
    } catch (e) {
      next(e);
    }
  };
  prot.get("/dashboard/summary", handleDashboardSummary);
  prot.get("/analytics/dashboard", handlePosDashboard);

  // Basic analytics: summary, top products, sales by hour.
  prot.get("/analytics/summary", (_req, res) => {
    const paidOrders = orders.filter((o) => o.isPaid);

    const totalSalesToday = paidOrders.reduce(
      (sum, o) => sum + calculateTotal(o.items),
      0
    );

    const productTotals: Record<string, { name: string; qty: number }> = {};
    paidOrders.forEach((o) => {
      o.items.forEach((it) => {
        if (!productTotals[it.id]) {
          productTotals[it.id] = { name: it.name, qty: 0 };
        }
        productTotals[it.id].qty += it.qty;
      });
    });

    const topProducts = Object.values(productTotals)
      .sort((a, b) => b.qty - a.qty)
      .slice(0, 5);

    const alerts: string[] = [];
    if (totalSalesToday === 0) {
      alerts.push("No paid sales recorded yet today.");
    } else if (totalSalesToday > 200) {
      alerts.push("Great day! Sales exceeded $200.");
    }

    res.json({
      totalSalesToday,
      topProducts,
      alerts
    });
  });

  prot.get("/analytics/sales-by-hour", (_req: Request, res: Response) => {
    const buckets: { hour: number; total: number }[] = [];
    for (let h = 0; h < 24; h++) {
      buckets.push({ hour: h, total: 0 });
    }

    orders
      .filter((o) => o.isPaid)
      .forEach((o) => {
        const date = new Date(o.createdAt);
        const hour = date.getHours();
        const idx = buckets.findIndex((b) => b.hour === hour);
        if (idx >= 0) {
          buckets[idx].total += calculateTotal(o.items);
        }
      });

    res.json(buckets);
  });

  // Reports & Analytics: date-range report with KPIs and day-by-day sales.
  prot.get("/analytics/report", (req: Request, res: Response) => {
    const fromStrRaw = (req.query.from as string | undefined)?.trim();
    const toStrRaw = (req.query.to as string | undefined)?.trim();

    let fromMs: number;
    let toMs: number;
    let salesByDayKeys: string[] | null = null;

    if (fromStrRaw && toStrRaw && CAL_YMD_RE.test(fromStrRaw) && CAL_YMD_RE.test(toStrRaw)) {
      fromMs = new Date(`${fromStrRaw}T00:00:00.000`).getTime();
      toMs = new Date(`${toStrRaw}T23:59:59.999`).getTime();
      salesByDayKeys = expandLocalYmdRangeInclusive(fromStrRaw, toStrRaw);
    } else {
      const to = toStrRaw ? new Date(toStrRaw) : new Date();
      const from = fromStrRaw ? new Date(fromStrRaw) : new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);
      const fromDay = new Date(from);
      fromDay.setHours(0, 0, 0, 0);
      const toDay = new Date(to);
      toDay.setHours(23, 59, 59, 999);
      fromMs = fromDay.getTime();
      toMs = toDay.getTime();
    }

    const paidInRange = orders.filter((o) => {
      if (!o.isPaid) return false;
      const d = new Date(o.createdAt).getTime();
      return d >= fromMs && d <= toMs;
    });

    const totalRevenue = paidInRange.reduce(
      (sum, o) => sum + calculateTotal(o.items),
      0
    );
    const totalTransactions = paidInRange.length;
    const avgTransactionValue =
      totalTransactions > 0 ? totalRevenue / totalTransactions : 0;
    const ledgerFrom = new Date(fromMs);
    ledgerFrom.setHours(0, 0, 0, 0);
    const ledgerTo = new Date(toMs);
    ledgerTo.setHours(23, 59, 59, 999);
    const ledgerRange = aggregateMoneyLedgerRange(ledgerFrom, ledgerTo);
    const netProfit = ledgerRange.net;

    const dayMap: Record<string, { revenue: number; count: number }> = {};
    paidInRange.forEach((o) => {
      const dateKey = localYmdFromTimestamp(new Date(o.createdAt).getTime());
      const rev = calculateTotal(o.items);
      if (!dayMap[dateKey]) dayMap[dateKey] = { revenue: 0, count: 0 };
      dayMap[dateKey].revenue += rev;
      dayMap[dateKey].count += 1;
    });

    const salesByDay: { date: string; revenue: number; salesCount: number }[] = [];
    if (salesByDayKeys) {
      for (const dateKey of salesByDayKeys) {
        const d = dayMap[dateKey] || { revenue: 0, count: 0 };
        salesByDay.push({ date: dateKey, revenue: d.revenue, salesCount: d.count });
      }
    } else {
      const curr = new Date(fromMs);
      curr.setHours(0, 0, 0, 0);
      const end = new Date(toMs);
      while (curr.getTime() <= end.getTime()) {
        const dateKey = localYmdFromTimestamp(curr.getTime());
        const d = dayMap[dateKey] || { revenue: 0, count: 0 };
        salesByDay.push({ date: dateKey, revenue: d.revenue, salesCount: d.count });
        curr.setDate(curr.getDate() + 1);
        if (salesByDay.length > 400) break;
      }
    }

    const orderIds = new Set(paidInRange.map((o) => o.id));
    const dayPayments = payments.filter((p) => orderIds.has(p.orderId));
    const byMethod: Record<string, { count: number; revenue: number }> = {};
    dayPayments.forEach((p) => {
      if (!byMethod[p.method]) byMethod[p.method] = { count: 0, revenue: 0 };
      byMethod[p.method].count += 1;
      byMethod[p.method].revenue += p.amount;
    });
    const salesByPaymentMethod = Object.entries(byMethod).map(([method, v]) => ({
      method: method.charAt(0).toUpperCase() + method.slice(1),
      salesCount: v.count,
      revenue: v.revenue
    }));

    const itemMap: Record<string, { qty: number; revenue: number }> = {};
    paidInRange.forEach((o) => {
      o.items.forEach((it) => {
        const name = it.name || it.id;
        if (!itemMap[name]) itemMap[name] = { qty: 0, revenue: 0 };
        itemMap[name].qty += it.qty ?? 1;
        itemMap[name].revenue += (it.price || 0) * (it.qty ?? 1);
      });
    });
    const salesByItem = Object.entries(itemMap)
      .map(([item, v]) => ({
        item,
        quantity: v.qty,
        revenue: v.revenue,
        percentOfTotal: totalRevenue > 0 ? (v.revenue / totalRevenue) * 100 : 0
      }))
      .sort((a, b) => b.revenue - a.revenue);

    res.json({
      from: new Date(fromMs).toISOString(),
      to: new Date(toMs).toISOString(),
      totalRevenue,
      netProfit,
      totalTransactions,
      avgTransactionValue,
      salesByDay,
      salesByItem,
      salesByPaymentMethod
    });
  });

  /** Same as `/api/analytics/report?from=&to=` (307 redirect for older clients). */
  prot.get("/reports", (req: Request, res: Response) => {
    const qs = new URLSearchParams();
    const from = req.query.from;
    const to = req.query.to;
    if (typeof from === "string") qs.set("from", from);
    if (typeof to === "string") qs.set("to", to);
    const suffix = qs.toString();
    res.redirect(307, `/api/analytics/report${suffix ? `?${suffix}` : ""}`);
  });

  // Profit Report: orders (reference) + money ledger (authoritative P&amp;L). Purchase costs are expenses in ledger.
  prot.get("/analytics/profit-report", (req: Request, res: Response) => {
    const fromStr = (req.query.from as string | undefined)?.trim();
    const toStr = (req.query.to as string | undefined)?.trim();

    let from: Date;
    let to: Date;
    if (fromStr && toStr && CAL_YMD_RE.test(fromStr) && CAL_YMD_RE.test(toStr)) {
      from = new Date(`${fromStr}T00:00:00.000`);
      to = new Date(`${toStr}T23:59:59.999`);
    } else {
      to = toStr ? new Date(toStr) : new Date();
      to.setHours(23, 59, 59, 999);
      from = fromStr ? new Date(fromStr) : new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
      from.setHours(0, 0, 0, 0);
    }

    const paidInRange = orders.filter((o) => {
      if (!o.isPaid) return false;
      const d = new Date(o.createdAt).getTime();
      return d >= from.getTime() && d <= to.getTime();
    });
    const totalSalesFromOrders = paidInRange.reduce((s, o) => s + calculateTotal(o.items), 0);

    const purchasesInRange = purchases.filter((p) => {
      const d = new Date(p.createdAt).getTime();
      return d >= from.getTime() && d <= to.getTime();
    });
    const totalPurchasesCost = purchasesInRange.reduce((s, p) => s + (p.cost ?? 0), 0);

    const ledger = aggregateMoneyLedgerRange(from, to);
    const totalSales = ledger.sales;
    const totalExpenses = ledger.expenses;
    const grossProfit = ledger.net;
    const profitMargin = totalSales > 0 ? (grossProfit / totalSales) * 100 : 0;

    const monthlyProfit: {
      month: string;
      sales: number;
      expenses: number;
      purchasesCost: number;
      profit: number;
    }[] = [];
    const curMonth = new Date(from.getFullYear(), from.getMonth(), 1);
    const lastMonth = new Date(to.getFullYear(), to.getMonth(), 1);
    while (curMonth <= lastMonth) {
      const ms = new Date(curMonth.getFullYear(), curMonth.getMonth(), 1, 0, 0, 0, 0);
      const me = new Date(curMonth.getFullYear(), curMonth.getMonth() + 1, 0, 23, 59, 59, 999);
      const L = aggregateMoneyLedgerRange(ms, me);
      const purchaseCost = purchases
        .filter((p) => {
          const d = new Date(p.createdAt).getTime();
          return d >= ms.getTime() && d <= me.getTime();
        })
        .reduce((s, p) => s + (p.cost ?? 0), 0);
      monthlyProfit.push({
        month: `${curMonth.getFullYear()}-${String(curMonth.getMonth() + 1).padStart(2, "0")}`,
        sales: L.sales,
        expenses: L.expenses,
        purchasesCost: purchaseCost,
        profit: L.net
      });
      curMonth.setMonth(curMonth.getMonth() + 1);
    }

    res.json({
      from: from.toISOString().slice(0, 10),
      to: to.toISOString().slice(0, 10),
      totalSales,
      totalSalesFromOrders,
      totalPurchasesCost,
      totalExpenses,
      grossProfit,
      profitMargin,
      monthlyProfit,
      note: "totalSales/totalExpenses/grossProfit use the money ledger. totalPurchasesCost is informational (also in expenses when recorded)."
    });
  });

  // Inventory Report: total items, value, stock, by category, low stock, top value
  prot.get("/analytics/inventory-report", (_req, res) => {
    const invList = menuProducts().map((p) => {
      const inv = inventoryMap.get(p.id) ?? { productId: p.id, qty: 0, unit: "pcs", lowStock: 10 };
      const value = inv.qty * (p.price || 0);
      return { item: p.name, category: p.category || "Other", stock: inv.qty, lowStock: inv.lowStock, value };
    });
    const ingList = menuIngredients().map((i) => ({
      item: i.name,
      category: "Ingredients",
      stock: i.stock_quantity,
      lowStock: i.low_stock_threshold,
      value: i.stock_quantity * (i.costPerUnit ?? 0)
    }));
    const allItems = [...invList, ...ingList];
    const totalItems = allItems.length;
    const totalValue = allItems.reduce((s, x) => s + x.value, 0);
    const totalStock = allItems.reduce((s, x) => s + x.stock, 0);
    const lowStockItems = allItems.filter((x) => x.stock <= x.lowStock);
    const byCategory: Record<string, number> = {};
    allItems.forEach((x) => {
      byCategory[x.category] = (byCategory[x.category] || 0) + x.value;
    });
    const inventoryByCategory = Object.entries(byCategory).map(([category, value]) => ({ category, value }));
    const topValueItems = [...allItems]
      .sort((a, b) => b.value - a.value)
      .slice(0, 15)
      .map((x) => ({ ...x, potentialProfit: Math.round(x.value * 0.35 * 100) / 100 }));
    res.json({
      totalItems,
      totalValue,
      totalStock,
      lowStockCount: lowStockItems.length,
      lowStockItems,
      inventoryByCategory,
      topValueItems
    });
  });

  // —— AI menu import (PDF / image / text → products + ingredients + recipes) ——
  prot.post("/menu/upload", menuMemoryUpload.single("file"), async (req: Request, res: Response) => {
    try {
      const file = req.file;
      if (!file?.buffer) {
        return res.status(400).json({ error: "Missing file (multipart field name: file)" });
      }
      const mime = file.mimetype || "application/octet-stream";
      const transcribe = menuOpenAi.hasOpenAiKey()
        ? (b64: string, m: string) => menuOpenAi.transcribeMenuImageBase64(b64, m)
        : undefined;
      const result = await menuExtract.extractMenuFromBuffer(file.buffer, mime, transcribe);
      res.json(result);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Menu extract failed";
      res.status(400).json({ error: msg });
    }
  });

  prot.post("/menu/ai-parse", async (req: Request, res: Response) => {
    const text = String((req.body as { text?: string })?.text ?? "").trim();
    if (!text) return res.status(400).json({ error: "text is required" });
    try {
      const items = await menuOpenAi.aiParseMenuItems(text);
      res.json({ items });
    } catch (e: unknown) {
      res.status(502).json({ error: e instanceof Error ? e.message : "AI parse failed" });
    }
  });

  prot.post("/products/bulk-create", (req: Request, res: Response) => {
    if (chefAbsentEffective()) return res.status(423).json({ error: "Chef absent — inventory locked." });
    const body = req.body as {
      items?: ParsedMenuItem[];
      defaultPrice?: number;
      defaultType?: string;
    };
    const rawItems = body.items;
    if (!Array.isArray(rawItems) || rawItems.length === 0) {
      return res.status(400).json({ error: "items: non-empty array required" });
    }
    const defaultPrice =
      body.defaultPrice != null && Number.isFinite(Number(body.defaultPrice)) && Number(body.defaultPrice) >= 0
        ? Number(body.defaultPrice)
        : 0;
    const defaultType: "veg" | "non_veg" | "egg" =
      body.defaultType === "non_veg" || body.defaultType === "egg" ? body.defaultType : "veg";

    const normalized: ParsedMenuItem[] = rawItems
      .filter((x) => x && typeof x.name === "string" && x.name.trim())
      .map((x) => ({
        name: String(x.name).trim(),
        category: String(x.category || "General").trim() || "General",
        price: typeof x.price === "number" && x.price >= 0 ? x.price : undefined,
        type: x.type === "veg" || x.type === "non_veg" || x.type === "egg" ? x.type : undefined
      }));
    const deduped = dedupeMenuItems(normalized);
    const maxP = menuProducts().reduce((m, p) => {
      const n = parseInt(String(p.id).replace(/\D/g, ""), 10) || 0;
      return Math.max(m, n);
    }, 0);
    let next = maxP;
    const created: Product[] = [];
    for (const it of deduped) {
      next += 1;
      const price = it.price ?? defaultPrice;
      const type: "veg" | "non_veg" | "egg" = it.type ?? defaultType;
      const newProduct: Product = {
        id: `P${next}`,
        name: it.name,
        price,
        category: it.category,
        type
      };
      menuProducts().push(newProduct);
      seedNewProductInventoryRow(newProduct.id);
      created.push(newProduct);
    }
    saveProducts(menuProducts());
    res.status(201).json({ created, count: created.length });
  });

  prot.post("/recipes/generate", async (req: Request, res: Response) => {
    const payload = (req.body as { products?: { id: string; name: string; category?: string }[] }).products;
    if (!Array.isArray(payload) || !payload.length) {
      return res.status(400).json({ error: "products: array of { id, name, category } required" });
    }
    const cleaned = payload
      .filter((p) => p && typeof p.id === "string" && typeof p.name === "string")
      .map((p) => ({
        id: String(p.id).trim(),
        name: String(p.name).trim(),
        category: String(p.category || "General").trim() || "General"
      }));
    try {
      const aiBlocks = await menuOpenAi.aiGenerateRecipes(cleaned.map((p) => ({ name: p.name, category: p.category })));
      const byName = new Map(cleaned.map((p) => [normalizeIngredientKey(p.name), p.id]));
      const recipesOut = aiBlocks
        .map((b) => {
          const productId = byName.get(normalizeIngredientKey(b.productName)) ?? null;
          if (!productId) return null;
          return {
            productId,
            productName: b.productName,
            confidence: b.confidence,
            needsReview: b.needsReview,
            ingredients: b.ingredients
          };
        })
        .filter((x): x is NonNullable<typeof x> => x != null);
      res.json({ recipes: recipesOut });
    } catch (e: unknown) {
      res.status(502).json({ error: e instanceof Error ? e.message : "Recipe generation failed" });
    }
  });

  prot.post("/recipes/save-ai", (req: Request, res: Response) => {
    if (chefAbsentEffective()) return res.status(423).json({ error: "Chef absent — inventory locked." });
    const body = req.body as {
      replace?: boolean;
      initialIngredientStock?: number;
      lowStockDefault?: number;
      entries?: {
        productId: string;
        confidence?: number;
        needsReview?: boolean;
        ingredients?: { name: string; qty: number; unit: string }[];
      }[];
    };
    const entries = body.entries;
    if (!Array.isArray(entries) || entries.length === 0) {
      return res.status(400).json({ error: "entries: non-empty array required" });
    }
    const replace = !!body.replace;
    const initialStock =
      body.initialIngredientStock != null && Number.isFinite(Number(body.initialIngredientStock))
        ? Math.max(0, Number(body.initialIngredientStock))
        : 0;
    const lowStockDefault =
      body.lowStockDefault != null && Number.isFinite(Number(body.lowStockDefault))
        ? Math.max(0, Number(body.lowStockDefault))
        : 5;

    const warnings: string[] = [];
    const metaBatch: RecipeProductMeta[] = [];
    let nextIngNum = menuIngredients().reduce((m, x) => {
      const n0 = parseInt(String(x.id).replace(/\D/g, ""), 10) || 0;
      return Math.max(m, n0);
    }, 0);

    for (const entry of entries) {
      const pid = String(entry.productId ?? "").trim();
      if (!pid || !menuProducts().some((p) => p.id === pid)) {
        warnings.push(`Unknown productId skipped: ${pid}`);
        continue;
      }
      if (replace) {
        const recipeLines = menuRecipes();
        for (let i = recipeLines.length - 1; i >= 0; i--) {
          if (recipeLines[i].productId === pid) recipeLines.splice(i, 1);
        }
      }

      for (const rawIng of entry.ingredients ?? []) {
        const n = normalizeParsedIngredient(rawIng);
        if (!n.name || n.qty <= 0) continue;
        const conv = ingredientQtyToStorage(n.qty, n.unit);
        if (!conv || conv.qty <= 0) {
          warnings.push(`${pid}: bad qty for ${n.name}`);
          continue;
        }
        const posUnit = normalizeIngredientUnit(conv.unit);
        if (!posUnit) {
          warnings.push(`${pid}: cannot map unit for ${n.name}`);
          continue;
        }

        const key = normalizeIngredientKey(n.name);
        let ingRow = menuIngredients().find((i) => normalizeIngredientKey(i.name) === key);
        if (!ingRow) {
          nextIngNum += 1;
          ingRow = {
            id: `I${nextIngNum}`,
            name: n.name,
            unit: posUnit,
            stock_quantity: initialStock,
            low_stock_threshold: lowStockDefault
          };
          menuIngredients().push(ingRow);
        }

        const recipeQty = conv.qty;
        const idx = menuRecipes().findIndex((r) => r.productId === pid && r.ingredientId === ingRow!.id);
        if (idx >= 0) menuRecipes()[idx].qty = roundRecipeQty(menuRecipes()[idx].qty + recipeQty);
        else menuRecipes().push({ productId: pid, ingredientId: ingRow.id, qty: roundRecipeQty(recipeQty) });
      }

      const conf =
        entry.confidence != null && Number.isFinite(Number(entry.confidence))
          ? Math.max(0, Math.min(100, Math.round(Number(entry.confidence))))
          : 70;
      const needsReview = entry.needsReview !== false;
      metaBatch.push({
        productId: pid,
        confidence: conf,
        needsReview,
        source: "ai_menu_import",
        updatedAt: new Date().toISOString()
      });
    }

    saveIngredients(menuIngredients());
    saveRecipes(menuRecipes());
    upsertRecipeMeta(metaBatch);
    res.status(201).json({ ok: true, warnings, metaUpdated: metaBatch.length });
  });

  function chefAbsentEffective(): boolean {
    return !!appSettings.chefAbsent;
  }

  function roundRecipeQty(q: number): number {
    return Math.round(q * 10_000) / 10_000;
  }

  app.use("/api", pub);
  app.use(
    "/api",
    authMiddleware,
    kitchenViewOnlyApiGate,
    (req: Request, _res: Response, next: NextFunction) => {
      if (req.user?.role === "super_admin") {
        next();
        return;
      }
      const sid = req.user?.storeId;
      if (!sid) {
        next();
        return;
      }
      runWithPosTenant({ storeId: sid }, () => next());
    },
    prot
  );
}


