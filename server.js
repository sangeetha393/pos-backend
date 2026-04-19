const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

// ✅ SIMPLE CORS FIX (no external package needed)
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  next();
});

// ✅ JSON support
app.use(express.json());

// ✅ TEST ROUTE (VERY IMPORTANT)
app.get("/", (req, res) => {
  res.send("Backend is running");
});

// ✅ YOUR PRODUCTS API (required for frontend)
app.get("/api/products/pos", (req, res) => {
  res.json([
    { id: 1, name: "Tea", price: 10 },
    { id: 2, name: "Coffee", price: 15 },
    { id: 3, name: "Sandwich", price: 40 }
  ]);
});

// ✅ OPTIONAL LOGIN MOCK (prevents frontend error)
app.post("/api/auth/login", (req, res) => {
  res.json({
    token: "dummy-token",
    user: { id: 1, name: "Admin" }
  });
});

// ✅ START SERVER
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});