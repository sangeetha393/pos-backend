import type { Request, Response, NextFunction } from "express";
import { clientIpFromHttpReq, isPrivateOrLoopbackIp, lanOnlyEnabled } from "../net/privateIp";

/** Blocks HTTP requests when CAFE_KOT_LAN_ONLY is on and the client is not on a private / loopback IPv4 address. */
export function lanOnlyMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!lanOnlyEnabled()) {
    next();
    return;
  }
  const ip = clientIpFromHttpReq(req);
  if (isPrivateOrLoopbackIp(ip)) {
    next();
    return;
  }
  res.status(403).json({
    error: "Connect to café Wi-Fi",
    code: "LAN_ONLY"
  });
}
