import express from "express";
import cors from "cors";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

/* =========================
   BASIC ROUTES
========================= */

app.get("/", (req, res) => {
  res.send("Backend running");
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

/* =========================
   PRODUCTS / MENU (ALL VARIANTS)
========================= */

const menuData = [
  { id: 1, name: "Tea", price: 10 },
  { id: 2, name: "Coffee", price: 15 },
  { id: 3, name: "Sandwich", price: 40 }
];

// main
app.get("/api/products/pos", (req, res) => {
  res.json(menuData);
});

// fallback 1
app.get("/api/products", (req, res) => {
  res.json(menuData);
});

// fallback 2
app.get("/api/menu", (req, res) => {
  res.json(menuData);
});

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
   TABLES
========================= */

app.get("/api/customer/table/:id", (req, res) => {
  res.json({
    table: req.params.id,
    status: "available",
    guests: 0
  });
});

/* =========================
   DASHBOARD
========================= */

app.get("/api/dashboard", (req, res) => {
  res.json({
    sales: 0,
    orders: 0,
    profit: 0
  });
});

/* =========================
   ORDERS
========================= */

app.get("/api/orders", (req, res) => {
  res.json([]);
});

app.post("/api/orders", (req, res) => {
  res.json({
    message: "Order placed",
    order: req.body
  });
});

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
   START SERVER
========================= */

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
/* =========================
   DASHBOARD FULL FIX
========================= */

// main dashboard summary
app.get("/api/dashboard/summary", (req, res) => {
  res.json({
    totalSales: 0,
    totalOrders: 0,
    avgOrderValue: 0,
    netProfit: 0
  });
});

// reports
app.get("/api/reports/7day", (req, res) => {
  res.json({
    sales: [],
    total: 0
  });
});

// inventory alerts
app.get("/api/inventory/alerts", (req, res) => {
  res.json([]);
});

// kitchen list
app.get("/api/kitchen", (req, res) => {
  res.json([]);
});

// transactions
app.get("/api/transactions", (req, res) => {
  res.json([]);
});

// waiter calls
app.get("/api/waiter-calls", (req, res) => {
  res.json([]);
});

// tables
app.get("/api/tables", (req, res) => {
  res.json([]);
});