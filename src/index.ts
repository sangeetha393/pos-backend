import express from "express";
import cors from "cors";

const app = express();

// ✅ MUST use Render port
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ✅ test route
app.get("/", (req, res) => {
  res.send("Backend running");
});

// ✅ health check
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// ✅ products (for your frontend)
app.get("/api/products/pos", (req, res) => {
  res.json([
    { id: 1, name: "Tea", price: 10 },
    { id: 2, name: "Coffee", price: 15 },
    { id: 3, name: "Sandwich", price: 40 }
  ]);
});

// ✅ START SERVER
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});