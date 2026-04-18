import type { IncomingMessage } from "http";
import type { Socket as NetSocket } from "net";
import type { Socket as IoSocket } from "socket.io";

/**
 * True for RFC1918 private IPv4 and loopback (POS on same machine, café LAN phones).
 * IPv6 loopback ::1 is treated as local; other IPv6 is rejected unless LAN-only is off.
 */
export function isPrivateOrLoopbackIp(raw: string): boolean {
  if (!raw || typeof raw !== "string") return false;
  const ip = raw.replace(/^::ffff:/i, "").trim();
  if (ip === "::1" || ip === "127.0.0.1") return true;
  const parts = ip.split(".").map((x) => Number(x));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) {
    return false;
  }
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

export function clientIpFromHttpReq(req: {
  ip?: string;
  socket: NetSocket;
  headers: IncomingMessage["headers"];
}): string {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.trim()) {
    return fwd.split(",")[0].trim();
  }
  if (Array.isArray(fwd) && fwd[0]) {
    return String(fwd[0]).split(",")[0].trim();
  }
  const fromReq = typeof req.ip === "string" ? req.ip.trim() : "";
  if (fromReq) return fromReq;
  return req.socket?.remoteAddress || "";
}

/** When true, HTTP + Socket.IO reject non–private-LAN clients. Set `CAFE_KOT_LAN_ONLY=1` for café Wi‑Fi only. */
export function lanOnlyEnabled(): boolean {
  const v = process.env.CAFE_KOT_LAN_ONLY;
  if (v === undefined || v === "") return false;
  return v === "1" || v.toLowerCase() === "true" || v.toLowerCase() === "yes";
}

/** Prefer X-Forwarded-For (Vite/nginx) then direct remote address. */
export function clientIpFromSocketHandshake(socket: IoSocket): string {
  const hdr = socket.handshake.headers["x-forwarded-for"];
  if (typeof hdr === "string" && hdr.trim()) {
    return hdr.split(",")[0].trim();
  }
  return socket.handshake.address || "";
}
