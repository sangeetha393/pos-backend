import crypto from "crypto";
import { getMysqlPool } from "../db/mysql";
import type { ResetTokenRow } from "./passwordResetTokenFileStore";
import { hashToken } from "./passwordResetTokenFileStore";

export async function issueResetTokenMysql(email: string): Promise<string> {
  const pool = getMysqlPool();
  if (!pool) throw new Error("MySQL pool not configured");
  const normalized = email.trim().toLowerCase();
  const raw = crypto.randomBytes(32).toString("hex");
  const tokenHash = hashToken(raw);
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
  await pool.execute("DELETE FROM password_resets WHERE LOWER(email) = ?", [normalized]);
  await pool.execute(
    "INSERT INTO password_resets (email, token, expires_at) VALUES (?, ?, ?)",
    [normalized, tokenHash, expiresAt]
  );
  return raw;
}

export async function findValidByRawTokenMysql(raw: string): Promise<ResetTokenRow | null> {
  const pool = getMysqlPool();
  if (!pool) return null;
  if (!raw || typeof raw !== "string") return null;
  const tokenHash = hashToken(raw.trim());
  const [rows] = await pool.execute(
    "SELECT email, expires_at FROM password_resets WHERE token = ? AND expires_at > NOW() LIMIT 1",
    [tokenHash]
  );
  const list = rows as { email: string; expires_at: Date }[];
  const row = list[0];
  if (!row) return null;
  return {
    tokenHash,
    email: row.email.toLowerCase(),
    expiresAt: new Date(row.expires_at).getTime()
  };
}

export async function deleteByRawTokenMysql(raw: string): Promise<void> {
  const pool = getMysqlPool();
  if (!pool) return;
  if (!raw || typeof raw !== "string") return;
  const tokenHash = hashToken(raw.trim());
  await pool.execute("DELETE FROM password_resets WHERE token = ?", [tokenHash]);
}
