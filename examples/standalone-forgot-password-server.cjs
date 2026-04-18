/**
 * Standalone CommonJS example (tutorial-style) — NOT the main POS server.
 *
 * Run:  node examples/standalone-forgot-password-server.cjs
 * Uses backend/.env (DB_* and EMAIL_*).
 *
 * Default port 4001 so Vite (3000) and POS API (4000) are untouched.
 * Reset links open THIS server’s HTML form (path /reset-password/:token).
 */
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const express = require("express");
const mysql = require("mysql2/promise");
const nodemailer = require("nodemailer");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");

const PORT = Number(process.env.STANDALONE_RESET_PORT) || 4001;
const FRONTEND_OR_SELF = (process.env.FRONTEND_URL || `http://localhost:${PORT}`).replace(/\/$/, "");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

let pool;

async function getPool() {
  if (pool) return pool;
  pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 5
  });
  return pool;
}

function mailer() {
  return nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS
    }
  });
}

// 1. FORGOT PASSWORD (SEND LINK)
app.post("/forgot-password", async (req, res) => {
  try {
    const email = (req.body.email || "").trim();
    if (!email) return res.status(400).send("Email required");

    const db = await getPool();
    const [rows] = await db.execute("SELECT email FROM users WHERE email = ?", [email]);
    if (rows.length === 0) return res.status(404).send("User not found");

    const token = crypto.randomBytes(32).toString("hex");
    const expiry = new Date(Date.now() + 10 * 60 * 1000);

    await db.execute("DELETE FROM password_resets WHERE email = ?", [email]);
    await db.execute(
      "INSERT INTO password_resets (email, token, expires_at) VALUES (?, ?, ?)",
      [email, token, expiry]
    );

    // Same host as this server so GET /reset-password/:token works
    const resetLink = `${FRONTEND_OR_SELF}/reset-password/${encodeURIComponent(token)}`;

    await mailer().sendMail({
      from: process.env.SMTP_FROM || process.env.EMAIL_USER,
      to: email,
      subject: "Reset Your Password",
      html: `
        <h3>Password Reset</h3>
        <p>Click the link below:</p>
        <a href="${resetLink}">${resetLink}</a>
        <p>This link expires in 10 minutes.</p>
      `
    });

    res.send("Reset link sent to email");
  } catch (err) {
    console.error(err);
    res.status(500).send("Server error");
  }
});

// 2. OPEN RESET PAGE (simple HTML form)
app.get("/reset-password/:token", async (req, res) => {
  try {
    const token = req.params.token;
    const db = await getPool();
    const [result] = await db.execute("SELECT * FROM password_resets WHERE token = ?", [token]);
    if (result.length === 0) return res.status(400).send("Invalid link");

    const record = result[0];
    if (new Date() > new Date(record.expires_at)) {
      await db.execute("DELETE FROM password_resets WHERE token = ?", [token]);
      return res.status(400).send("Link expired");
    }

    res.type("html").send(`
      <!DOCTYPE html>
      <html><head><meta charset="utf-8"><title>Reset Password</title></head>
      <body style="font-family:sans-serif;max-width:400px;margin:2rem auto;">
        <h2>Reset Password</h2>
        <form method="POST" action="/reset-password">
          <input type="hidden" name="token" value="${token.replace(/"/g, "")}" />
          <p><input type="password" name="password" placeholder="New password" required style="width:100%;padding:8px" /></p>
          <button type="submit">Reset Password</button>
        </form>
      </body></html>
    `);
  } catch (err) {
    console.error(err);
    res.status(500).send("Server error");
  }
});

// 3. SAVE NEW PASSWORD
app.post("/reset-password", async (req, res) => {
  try {
    const token = req.body.token;
    const password = req.body.password;
    if (!token || !password) return res.status(400).send("Token and password required");

    const db = await getPool();
    const [result] = await db.execute("SELECT * FROM password_resets WHERE token = ?", [token]);
    if (result.length === 0) return res.status(400).send("Invalid token");

    const record = result[0];
    if (new Date() > new Date(record.expires_at)) {
      await db.execute("DELETE FROM password_resets WHERE token = ?", [token]);
      return res.status(400).send("Token expired");
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    await db.execute("UPDATE users SET password = ? WHERE email = ?", [hashedPassword, record.email]);
    await db.execute("DELETE FROM password_resets WHERE email = ?", [record.email]);

    res.send("Password updated successfully");
  } catch (err) {
    console.error(err);
    res.status(500).send("Server error");
  }
});

app.listen(PORT, () => {
  console.log(`Standalone forgot-password server: http://localhost:${PORT}`);
  console.log(`POST http://localhost:${PORT}/forgot-password  body: {"email":"..."}`);
});
