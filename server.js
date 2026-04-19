const express = require("express");
const cors = require("cors");

const app = express();

// ✅ Allow all frontend requests (fixes "can't connect" issue)
app.use(cors());

// Optional but recommended
app.use(express.json());