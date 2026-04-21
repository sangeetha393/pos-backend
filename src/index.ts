import express from "express";
import cors from "cors";
import fs from "fs";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

/* =========================
   SIMPLE FILE STORAGE (CLIENT SAFE)
========================= */

const DB_FILE = "./orders.json";

let orders: any[] = [];
let kots: any[] = [];

if (fs.existsSync(DB_FILE)) {
  orders = JSON.parse(fs.readFileSync(DB_FILE, "utf-8"));
}

function saveOrders() {
  fs.writeFileSync(DB_FILE, JSON.stringify(orders, null, 2));
}

/* =========================
   BASIC
========================= */

app.get("/", (req, res) => {
  res.send("Backend running");
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

/* =========================
   PRODUCTS (QR MENU)
========================= */

const menuData = [
  { id: 1, name: "Tea", price: 10 },
  { id: 2, name: "Coffee", price: 15 },
  { id: 3, name: "Sandwich", price: 40 }
];

app.get("/api/products/pos", (req, res) => res.json(menuData));
app.get("/api/products", (req, res) => res.json(menuData));
app.get("/api/menu", (req, res) => res.json(menuData));

/* =========================
   SETTINGS
========================= */

app.get("/api/settings", (req, res) => {
  res.json({
    restaurantName: "My Cafe",
    currency: "INR",
    taxPercent: 5
  });
});

/* =========================
   TABLES (FIXED STRUCTURE)
========================= */

const tables = [
  { id: "T1", name: "Table 1", status: "free" },
  { id: "T2", name: "Table 2", status: "occupied" },
  { id: "T3", name: "Table 3", status: "free" }
];

app.get("/api/tables/view", (req, res) => {
  res.json({
    sections: [
      {
        name: "Main",
        tables
      }
    ],
    summary: {
      occupied: tables.filter(t => t.status === "occupied").length,
      free: tables.filter(t => t.status === "free").length,
      total: tables.length
    }
  });
});

/* =========================
   DASHBOARD
========================= */

app.get("/api/dashboard", (req, res) => {
  res.json({
    totalSales: orders.reduce((a, o) => a + (o.total || 0), 0),
    totalOrders: orders.length,
    avgOrderValue: orders.length
      ? orders.reduce((a, o) => a + (o.total || 0), 0) / orders.length
      : 0,
    netProfit: 0
  });
});

app.get("/api/dashboard/summary", (req, res) => {
  res.json({
    date: new Date(),
    totalSales: orders.reduce((a, o) => a + (o.total || 0), 0),
    totalOrders: orders.length,
    avgOrderValue: orders.length
      ? orders.reduce((a, o) => a + (o.total || 0), 0) / orders.length
      : 0,
    netProfit: 0,
    lowStockItems: 0
  });
});

/* =========================
   ANALYTICS (REQUIRED)
========================= */

app.get("/api/analytics/dashboard", (req, res) => {
  res.json({
    todayRevenue: orders.reduce((a, o) => a + (o.total || 0), 0),
    todayPurchase: 0,
    monthRevenue: 0,
    monthPurchase: 0,
    recentSales: orders,
    inventorySnapshot: {
      healthy: 0,
      lowStock: 0,
      outOfStock: 0
    },
    topItemsToday: [],
    runoutAlerts: []
  });
});

app.get("/api/analytics/report", (req, res) => {
  res.json({
    totalRevenue: orders.reduce((a, o) => a + (o.total || 0), 0),
    totalTransactions: orders.length,
    netProfit: 0,
    series: []
  });
});

/* =========================
   KOT (KITCHEN)
========================= */

app.get("/api/kots", (req, res) => {
  res.json({
    new: kots.filter(k => k.status === "new"),
    cooking: kots.filter(k => k.status === "cooking"),
    ready: kots.filter(k => k.status === "ready")
  });
});

/* =========================
   ORDERS (WITH TABLE SUPPORT)
========================= */

app.get("/api/orders", (req, res) => res.json(orders));

app.post("/api/orders", (req, res) => {
  const order = {
    id: Date.now().toString(),
    tableId: req.body.tableId || "T1",
    items: req.body.items || [],
    total: req.body.total || 0,
    status: "new",
    createdAt: new Date()
  };

  orders.push(order);
  saveOrders();

  kots.push({
    id: order.id,
    tableId: order.tableId,
    status: "new"
  });

  res.json(order);
});

/* =========================
   OTHER REQUIRED APIs
========================= */

app.get("/api/reports/7days", (req, res) => res.json([]));
app.get("/api/inventory/alerts", (req, res) => res.json([]));
app.get("/api/inventory/value", (req, res) =>
  res.json({ totalInventoryValue: 0 })
);
app.get("/api/transactions", (req, res) => res.json([]));
app.get("/api/waiter-calls", (req, res) => res.json([]));
app.get("/api/expenses", (req, res) => res.json([]));
app.get("/api/loyalty/transactions", (req, res) => res.json([]));
app.get("/api/ingredients", (req, res) => res.json([]));
app.get("/api/inventory", (req, res) => res.json([]));
app.get("/api/wastage", (req, res) => res.json([]));

/* =========================
   AUTH
========================= */

app.post("/api/auth/login", (req, res) => {
  res.json({
    token: "dummy-token",
    user: { id: 1, name: "Admin" }
  });
});

/* =========================
   START
========================= */

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
// inventory notifications (FIX)
app.get("/api/inventory/notifications", (req, res) => {
  res.json({
    lowStock: [],
    outOfStock: [],
    expiringSoon: []
  });
});