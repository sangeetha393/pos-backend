import fs from "fs";
import path from "path";
import { DATA_DIR } from "../paths";
import { removeStoreFeaturesRow } from "../features/storeFeatureStore";
import { sanitizeStoreId, storeDir } from "./posStoreRegistry";
import { writeJsonValueAtomicSync } from "../storage/jsonPersistence";

const USERS_FILE = path.join(DATA_DIR, "users.json");
const STAFF_FILE = path.join(DATA_DIR, "staff.json");

type UserRow = {
  id: string;
  role: string;
  assignedStoreId?: string;
  staffMemberId?: string;
};

export type DeleteTenantResult =
  | { ok: true; removedUsers: number; removedStaffRecords: number; storeId: string }
  | { ok: false; error: string; code: string };

/**
 * Remove a café tenant: admin + linked staff users, staff.json rows, store folder,
 * store-features row. File-based deployment; PostgreSQL-only data is not purged here.
 */
export function deleteTenantFromDisk(storeIdRaw: string): DeleteTenantResult {
  const sid = sanitizeStoreId(storeIdRaw);
  if (!storeIdRaw?.trim()) {
    return { ok: false, error: "storeId required", code: "BAD_REQUEST" };
  }
  const platformSid = sanitizeStoreId(process.env.SUPER_ADMIN_TENANT_ID || "__platform__");
  if (sid === platformSid) {
    return { ok: false, error: "Cannot remove the platform seller tenant.", code: "FORBIDDEN_TENANT" };
  }

  let users: UserRow[];
  try {
    const raw = fs.readFileSync(USERS_FILE, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    users = Array.isArray(parsed) ? (parsed as UserRow[]) : [];
  } catch {
    return { ok: false, error: "Could not read users file.", code: "IO_ERROR" };
  }

  const adminForStore = users.find((u) => u.role === "admin" && sanitizeStoreId(u.id) === sid);
  const hasLinkedUsers = users.some(
    (u) => u.assignedStoreId && sanitizeStoreId(u.assignedStoreId) === sid
  );
  let hasFolder = false;
  try {
    hasFolder = fs.existsSync(storeDir(sid));
  } catch {
    /* ignore */
  }

  if (!adminForStore && !hasLinkedUsers && !hasFolder) {
    return { ok: false, error: "No café found for this store id.", code: "NOT_FOUND" };
  }

  const staffMemberIdsToRemove = new Set<string>();
  const nextUsers = users.filter((u) => {
    if (u.role === "super_admin") return true;
    if (u.role === "admin" && sanitizeStoreId(u.id) === sid) return false;
    if (u.assignedStoreId && sanitizeStoreId(u.assignedStoreId) === sid) {
      if (typeof u.staffMemberId === "string" && u.staffMemberId.trim()) {
        staffMemberIdsToRemove.add(u.staffMemberId.trim());
      }
      return false;
    }
    return true;
  });

  const removedUsers = users.length - nextUsers.length;

  type StaffRow = { id: string };
  let staff: StaffRow[] = [];
  try {
    const sr = fs.readFileSync(STAFF_FILE, "utf-8");
    const parsed = JSON.parse(sr) as unknown;
    staff = Array.isArray(parsed) ? (parsed as StaffRow[]) : [];
  } catch {
    staff = [];
  }
  const nextStaff = staff.filter((s) => !staffMemberIdsToRemove.has(s.id));
  const removedStaffRecords = staff.length - nextStaff.length;

  try {
    fs.mkdirSync(path.dirname(USERS_FILE), { recursive: true });
    writeJsonValueAtomicSync(USERS_FILE, nextUsers);
    writeJsonValueAtomicSync(STAFF_FILE, nextStaff);
  } catch (e) {
    console.error("[tenant-delete] save failed", e);
    return { ok: false, error: "Failed to save users/staff.", code: "IO_ERROR" };
  }

  removeStoreFeaturesRow(sid);

  try {
    const dir = storeDir(sid);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch (e) {
    console.error("[tenant-delete] rm store dir failed", e);
  }

  return { ok: true, removedUsers, removedStaffRecords, storeId: sid };
}
