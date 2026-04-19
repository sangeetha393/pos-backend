const express = require("express");   // ✅ IMPORTANT
const app = express();

app.get("/api/products/pos", (req, res) => {
  res.json([
    { id: 1, name: "Tea", price: 10 },
    { id: 2, name: "Coffee", price: 15 },
    { id: 3, name: "Sandwich", price: 40 }
  ]);
});

// ✅ VERY IMPORTANT (server must listen)
const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});