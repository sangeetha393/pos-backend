import express from "express";
import cors from "cors";

const app = express();

// ✅ Render port
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

/* =========================
   BASIC ROUTES
========================= */

// root
app.get("/", (req, res) => {
  res.send("Backend running");
});

// health
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

/* =========================
   PRODUCTS (MENU)
========================= */

app.get("/api/products/pos", (req, res) => {
  res.json([
    { id: 1, name: "Tea", price: 10 },
    { id: 2, name: "Coffee", price: 15 },
    { id: 3, name: "Sandwich", price: 40 }
  ]);
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
   ORDERS (BASIC MOCK)
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
   LOGIN (MOCK)
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