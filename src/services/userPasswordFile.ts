import fs from "fs";
import path from "path";
import bcrypt from "bcryptjs";
import { DATA_DIR } from "../paths";
import { readJsonWithRecoverySync, writeJsonValueAtomicSync } from "../storage/jsonPersistence";

const USERS_FILE = path.join(DATA_DIR, "users.json");
const BCRYPT_ROUNDS = 10;

type JsonUser = {
  id: string;
  email: string;
  password: string;
  [key: string]: unknown;
};

function readUsers(): JsonUser[] {
  return readJsonWithRecoverySync(DATA_DIR, USERS_FILE, [], (v): v is JsonUser[] => Array.isArray(v));
}

export async function updateUserPasswordByEmail(email: string, plainPassword: string): Promise<boolean> {
  const normalized = email.trim().toLowerCase();
  const users = readUsers();
  const idx = users.findIndex((u) => u.email && u.email.toLowerCase() === normalized);
  if (idx === -1) return false;
  users[idx].password = await bcrypt.hash(plainPassword, BCRYPT_ROUNDS);
  fs.mkdirSync(path.dirname(USERS_FILE), { recursive: true });
  writeJsonValueAtomicSync(USERS_FILE, users);
  return true;
}

export function userExistsByEmail(email: string): boolean {
  const normalized = email.trim().toLowerCase();
  return readUsers().some((u) => u.email && u.email.toLowerCase() === normalized);
}
