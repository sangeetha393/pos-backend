import type { ResultSetHeader } from "mysql2";
import { getMysqlPool } from "../db/mysql";
import bcrypt from "bcryptjs";

const BCRYPT_ROUNDS = 10;

/** Update password in MySQL `users` table if a row exists for this email. */
export async function updateUserPasswordMysql(email: string, plainPassword: string): Promise<boolean> {
  const pool = getMysqlPool();
  if (!pool) return false;
  const normalized = email.trim().toLowerCase();
  const hash = await bcrypt.hash(plainPassword, BCRYPT_ROUNDS);
  const [result] = await pool.execute<ResultSetHeader>(
    "UPDATE users SET password = ? WHERE LOWER(email) = ?",
    [hash, normalized]
  );
  return result.affectedRows > 0;
}
