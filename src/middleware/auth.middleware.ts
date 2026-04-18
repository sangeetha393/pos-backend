import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { getJwtSecret } from "../auth/jwtSecret";
import { storeIdFromDecodedJwtPayload } from "../auth/jwtStoreId";

type JwtPayload = { userId?: string; role?: string; storeId?: string };

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header || typeof header !== "string" || !header.startsWith("Bearer ")) {
    console.warn("[auth] 401 missing bearer", req.method, req.originalUrl || req.url);
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  const token = header.slice("Bearer ".length).trim();
  if (!token) {
    console.warn("[auth] 401 empty token", req.method, req.originalUrl || req.url);
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  try {
    const decoded = jwt.verify(token, getJwtSecret()) as JwtPayload;
    const userId = decoded?.userId;
    const role = decoded?.role;
    if (!userId || !role) {
      console.warn("[auth] 403 invalid payload", req.method, req.originalUrl || req.url);
      res.status(403).json({ error: "Invalid token" });
      return;
    }
    if (
      role !== "admin" &&
      role !== "staff" &&
      role !== "manager" &&
      role !== "chief" &&
      role !== "kitchen" &&
      role !== "super_admin"
    ) {
      console.warn("[auth] 403 bad role", req.method, req.originalUrl || req.url);
      res.status(403).json({ error: "Invalid token" });
      return;
    }
    const storeId = storeIdFromDecodedJwtPayload(decoded);
    if (!storeId) {
      console.warn("[auth] 403 missing store on token", req.method, req.originalUrl || req.url);
      res.status(403).json({
        error: "Invalid token (missing store). Sign out and sign in again."
      });
      return;
    }
    req.user = { userId, role, storeId };
    next();
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    const expired = e instanceof Error && e.name === "TokenExpiredError";
    console.warn("[auth] JWT verify failed", req.method, req.originalUrl || req.url, expired ? "(expired)" : msg);
    res.status(403).json({
      error: expired
        ? "Session expired — please sign in again."
        : "Invalid session — sign out and sign in again (token may be from before the server JWT secret changed)."
    });
  }
}
