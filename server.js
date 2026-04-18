const express = require("express");

const app = express();
app.use(express.json());

app.get("/", (req, res) => {
  res.send("API running");
});

app.post("/order", (req, res) => {
  console.log(req.body);
  res.json({ success: true });
});

app.listen(3000, () => {
  console.log("Server running on port 3000");
});
app.listen(process.env.PORT || 3000, () => {
    console.log("Server running");
  });
