import express from "express";
import cors from "cors";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

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
   PRODUCTS
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
   DASHBOARD (CRITICAL)
========================= */

app.get("/api/dashboard", (req, res) => {
  res.json({
    totalSales: 0,
    totalOrders: 0,
    avgOrderValue: 0,
    netProfit: 0
  });
});

app.get("/api/dashboard/summary", (req, res) => {
  res.json({
    totalSales: 0,
    totalOrders: 0,
    avgOrderValue: 0,
    netProfit: 0
  });
});

/* =========================
   REPORTS
========================= */

app.get("/api/reports/7days", (req, res) => {
  res.json([]);
});

/* =========================
   OTHER REQUIRED APIs
========================= */

app.get("/api/inventory/alerts", (req, res) => res.json([]));
app.get("/api/kitchen", (req, res) => res.json([]));
app.get("/api/transactions", (req, res) => res.json([]));
app.get("/api/waiter-calls", (req, res) => res.json([]));
app.get("/api/tables", (req, res) => res.json([]));

/* =========================
   ORDERS
========================= */

app.get("/api/orders", (req, res) => res.json([]));

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
   START SERVER (LAST)
========================= */

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});