import crypto from "crypto";
import fs from "fs";
import path from "path";
import { DATA_DIR } from "../paths";
import { readJsonWithRecoverySync, writeJsonValueAtomicSync } from "../storage/jsonPersistence";

const TOKENS_FILE = path.join(DATA_DIR, "password-reset-tokens.json");

export type ResetTokenRow = {
  tokenHash: string;
  email: string;
  expiresAt: number;
};

function hashToken(raw: string): string {
  return crypto.createHash("sha256").update(raw, "utf8").digest("hex");
}

function load(): ResetTokenRow[] {
  return readJsonWithRecoverySync(DATA_DIR, TOKENS_FILE, [], (v): v is ResetTokenRow[] =>
    Array.isArray(v)
  );
}

function save(rows: ResetTokenRow[]): void {
  fs.mkdirSync(path.dirname(TOKENS_FILE), { recursive: true });
  writeJsonValueAtomicSync(TOKENS_FILE, rows);
}

function pruneExpired(rows: ResetTokenRow[]): ResetTokenRow[] {
  const now = Date.now();
  return rows.filter((r) => r.expiresAt > now);
}

export { hashToken };

export function issueResetTokenFile(email: string): string {
  const normalized = email.trim().toLowerCase();
  const others = pruneExpired(load()).filter((r) => r.email !== normalized);
  const raw = crypto.randomBytes(32).toString("hex");
  const tokenHash = hashToken(raw);
  const expiresAt = Date.now() + 60 * 60 * 1000;
  others.push({ tokenHash, email: normalized, expiresAt });
  save(others);
  return raw;
}

export function findValidByRawTokenFile(raw: string): ResetTokenRow | null {
  if (!raw || typeof raw !== "string") return null;
  const tokenHash = hashToken(raw.trim());
  const rows = pruneExpired(load());
  const row = rows.find((r) => r.tokenHash === tokenHash);
  if (!row) return null;
  if (Date.now() > row.expiresAt) {
    deleteByHashFile(tokenHash);
    return null;
  }
  return row;
}

export function deleteByRawTokenFile(raw: string): void {
  if (!raw || typeof raw !== "string") return;
  deleteByHashFile(hashToken(raw.trim()));
}

function deleteByHashFile(tokenHash: string): void {
  const rows = load().filter((r) => r.tokenHash !== tokenHash);
  save(rows);
}
