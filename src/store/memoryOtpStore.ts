/**
 * In-memory OTP store (single Node process). Cleared on server restart.
 */

const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes
const RESET_WINDOW_MS = 10 * 60 * 1000; // after verify-otp, 10 minutes to reset-password

type PendingEntry = { phase: "pending"; otp: string; expiresAt: number };
type VerifiedEntry = { phase: "verified"; resetAllowedUntil: number };
type Entry = PendingEntry | VerifiedEntry;

const store = new Map<string, Entry>();

function norm(email: string): string {
  return email.trim().toLowerCase();
}

export function saveOtp(email: string, otp: string): void {
  store.set(norm(email), {
    phase: "pending",
    otp,
    expiresAt: Date.now() + OTP_TTL_MS
  });
}

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: "not_found" | "expired" | "invalid_otp" | "wrong_phase" };

export function verifyOtp(email: string, otp: string): VerifyResult {
  const k = norm(email);
  const entry = store.get(k);
  if (!entry) return { ok: false, reason: "not_found" };
  if (entry.phase !== "pending") return { ok: false, reason: "wrong_phase" };
  if (Date.now() > entry.expiresAt) {
    store.delete(k);
    return { ok: false, reason: "expired" };
  }
  if (entry.otp !== String(otp).trim()) {
    return { ok: false, reason: "invalid_otp" };
  }
  store.set(k, {
    phase: "verified",
    resetAllowedUntil: Date.now() + RESET_WINDOW_MS
  });
  return { ok: true };
}

export type ResetGateResult =
  | { ok: true }
  | { ok: false; reason: "not_verified" | "expired" | "wrong_phase" };

export function assertCanResetPassword(email: string): ResetGateResult {
  const k = norm(email);
  const entry = store.get(k);
  if (!entry) return { ok: false, reason: "not_verified" };
  if (entry.phase !== "verified") return { ok: false, reason: "wrong_phase" };
  if (Date.now() > entry.resetAllowedUntil) {
    store.delete(k);
    return { ok: false, reason: "expired" };
  }
  return { ok: true };
}

export function deleteOtp(email: string): void {
  store.delete(norm(email));
}
