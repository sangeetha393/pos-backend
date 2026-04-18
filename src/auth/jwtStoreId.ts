import fs from "fs";
import path from "path";
import jwt from "jsonwebtoken";
import { DATA_DIR } from "../paths";
import { sanitizeStoreId } from "../tenant/posStoreRegistry";
import { getJwtSecret } from "./jwtSecret";

export type JwtUserRole = "admin" | "staff" | "manager" | "chief" | "kitchen" | "super_admin";

export type JwtStoreUser = {
  id: string;
  role: JwtUserRole;
  assignedStoreId?: string;
};

const USERS_FILE = path.join(DATA_DIR, "users.json");

function isJwtUserRole(r: unknown): r is JwtUserRole {
  return (
    r === "admin" ||
    r === "staff" ||
    r === "manager" ||
    r === "chief" ||
    r === "kitchen" ||
    r === "super_admin"
  );
}

function loadUsersFromDisk(): JwtStoreUser[] {
  try {
    const data = fs.readFileSync(USERS_FILE, "utf-8");
    const parsed = JSON.parse(data) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: JwtStoreUser[] = [];
    for (const row of parsed) {
      if (!row || typeof row !== "object") continue;
      const o = row as Record<string, unknown>;
      const id = typeof o.id === "string" ? o.id.trim() : "";
      if (!id || !isJwtUserRole(o.role)) continue;
      const assigned =
        typeof o.assignedStoreId === "string" && o.assignedStoreId.trim() ? o.assignedStoreId.trim() : undefined;
      out.push({ id, role: o.role, assignedStoreId: assigned });
    }
    return out;
  } catch {
    return [];
  }
}

export function jwtStoreIdForUser(user: JwtStoreUser): string {
  if (user.role === "super_admin") {
    return sanitizeStoreId(process.env.SUPER_ADMIN_TENANT_ID || "__platform__");
  }
  if (user.role === "staff" || user.role === "kitchen") {
    const sid = user.assignedStoreId?.trim();
    if (!sid) throw new Error("STAFF_NOT_LINKED");
    return sanitizeStoreId(sid);
  }
  if ((user.role === "manager" || user.role === "chief") && user.assignedStoreId?.trim()) {
    return sanitizeStoreId(user.assignedStoreId.trim());
  }
  return sanitizeStoreId(user.id);
}

/**
 * JWTs issued before `storeId` was embedded — derive tenant from users.json (or admin id fallback).
 */
export function resolveLegacyJwtStoreId(userId: string, roleFromToken: JwtUserRole): string | null {
  const rows = loadUsersFromDisk();
  const u = rows.find((x) => x.id === userId);
  if (u) {
    if (u.role !== roleFromToken) return null;
    try {
      return jwtStoreIdForUser(u);
    } catch {
      return null;
    }
  }
  if (roleFromToken === "admin" || roleFromToken === "manager" || roleFromToken === "chief") {
    return sanitizeStoreId(userId);
  }
  return null;
}

type JwtPayload = { userId?: string; role?: string; storeId?: string };

/**
 * Resolve `storeId` from an already-verified JWT payload (same rules as auth middleware).
 */
export function storeIdFromDecodedJwtPayload(decoded: JwtPayload): string | null {
  const userId = decoded?.userId;
  const role = decoded?.role;
  if (!userId || !role) return null;
  if (
    role !== "admin" &&
    role !== "staff" &&
    role !== "manager" &&
    role !== "chief" &&
    role !== "kitchen" &&
    role !== "super_admin"
  ) {
    return null;
  }
  let storeId = typeof decoded?.storeId === "string" && decoded.storeId.trim() ? decoded.storeId.trim() : "";
  if (!storeId) {
    storeId = resolveLegacyJwtStoreId(userId, role as JwtUserRole) ?? "";
  }
  return storeId ? sanitizeStoreId(storeId) : null;
}

/**
 * Resolve `storeId` from a JWT (same rules as auth middleware). Returns null if invalid/expired.
 */
export function storeIdFromJwtToken(token: string): string | null {
  try {
    const decoded = jwt.verify(token, getJwtSecret()) as JwtPayload;
    return storeIdFromDecodedJwtPayload(decoded);
  } catch {
    return null;
  }
}

/** Parse `Authorization: Bearer …` and return tenant store id, or null. */
export function storeIdFromAuthorizationHeader(header: string | undefined): string | null {
  if (!header || typeof header !== "string" || !header.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  if (!token) return null;
  return storeIdFromJwtToken(token);
}
