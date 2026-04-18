import { getMysqlPool } from "../db/mysql";
import type { ResetTokenRow } from "./passwordResetTokenFileStore";
import {
  issueResetTokenFile,
  findValidByRawTokenFile,
  deleteByRawTokenFile
} from "./passwordResetTokenFileStore";
import {
  issueResetTokenMysql,
  findValidByRawTokenMysql,
  deleteByRawTokenMysql
} from "./passwordResetTokenMysqlStore";

export type { ResetTokenRow };

function useMysql(): boolean {
  return getMysqlPool() !== null;
}

export async function issueResetToken(email: string): Promise<string> {
  if (useMysql()) return issueResetTokenMysql(email);
  return issueResetTokenFile(email);
}

export async function findValidByRawToken(raw: string): Promise<ResetTokenRow | null> {
  if (useMysql()) return findValidByRawTokenMysql(raw);
  return findValidByRawTokenFile(raw);
}

export async function deleteByRawToken(raw: string): Promise<void> {
  if (useMysql()) return deleteByRawTokenMysql(raw);
  deleteByRawTokenFile(raw);
}
