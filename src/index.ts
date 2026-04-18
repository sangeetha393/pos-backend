import "express-async-errors";
import "./loadEnv";
import fs from "fs";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import { createServer } from "http";
import { Server } from "socket.io";
import { registerRoutes, bootstrapPosMenuInventoryPersistence } from "./routes";
import { createKotRouter } from "./routes/kotApi";
import { registerOpsRoutes } from "./ops/routes";
import { registerSuperAdminRoutes } from "./routes/superAdminRoutes";
import forgotOtpApiRoutes from "./routes/forgotOtpApiRoutes";
import { errorMiddleware } from "./middleware/error.middleware";
import { authMiddleware } from "./middleware/auth.middleware";
import { getStoreFeaturesForStore } from "./features/storeFeatureStore";
import { attachStoreFeatureIo } from "./features/storeFeatureBroadcast";
import { storeIdFromJwtToken } from "./auth/jwtStoreId";
import type { Request, Response, NextFunction } from "express";
import { initDatabase, closeDatabase } from "./db/pool";
import { initOrderStore } from "./orders/orderStore";
import { setKotSocketEmitter } from "./orders/kotNotify";
import { lanOnlyMiddleware } from "./middleware/lanOnly.middleware";
import { isPrivateOrLoopbackIp, lanOnlyEnabled, clientIpFromSocketHandshake } from "./net/privateIp";
import { DATA_DIR, UPLOADS_DIR } from "./paths";
import {
  runStartupJsonRecovery,
  startBackupScheduler,
  flushAllJsonWriteQueues
} from "./storage/jsonPersistence";
import { initMongoQr, closeMongoQr } from "./db/mongoQr";
import { isPostgresLive } from "./db/pool";
import { initSqliteOrderBackup } from "./db/sqljsOrderBackup";

const app = express();
app.set("trust proxy", 1);
const port = Number(process.env.PORT) || 4000;

/** Direct hit on :4000/health (without /api) for load balancers / probes */
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    ts: new Date().toISOString(),
    postgres: isPostgresLive()
  });
});

/** Probe-friendly; mirrors `GET` on `/api` after POS routes register. */
app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    ts: new Date().toISOString(),
    postgres: isPostgresLive(),
    service: "pos-backend"
  });
});

app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use("/uploads", express.static(UPLOADS_DIR));
app.use(lanOnlyMiddleware);

console.log("[routes] Mounting /api (OTP + public + JWT-protected POS API)…");
app.use("/api", forgotOtpApiRoutes);

void (async () => {
  await initDatabase();
  await initMongoQr();

  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch {
    /* ignore */
  }
  runStartupJsonRecovery(DATA_DIR);
  startBackupScheduler(DATA_DIR);

  await initSqliteOrderBackup();
  await initOrderStore();
  await bootstrapPosMenuInventoryPersistence();
  registerRoutes(app);
  registerSuperAdminRoutes(app);

  function kotKitchenFeatureGate(req: Request, res: Response, next: NextFunction): void {
    if (!req.user) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    if (req.user.role === "super_admin") {
      res.status(403).json({ error: "Seller accounts cannot use the KOT API" });
      return;
    }
    if (getStoreFeaturesForStore(req.user.storeId).kitchen) {
      next();
      return;
    }
    res.status(403).json({ message: "Feature disabled", code: "FEATURE_DISABLED", feature: "kitchen" });
  }

  app.use("/api/kot", authMiddleware, kotKitchenFeatureGate, createKotRouter());
  registerOpsRoutes(app);
  app.use(errorMiddleware);
  const httpServer = createServer(app);
  const io = new Server(httpServer, {
    cors: { origin: true, credentials: true }
  });
  if (lanOnlyEnabled()) {
    io.use((socket, next) => {
      const raw = clientIpFromSocketHandshake(socket);
      if (isPrivateOrLoopbackIp(raw)) {
        next();
        return;
      }
      next(new Error("LAN_ONLY"));
    });
  }
  attachStoreFeatureIo(io);
  io.on("connection", (socket) => {
    const raw = socket.handshake.auth as { token?: string } | undefined;
    const token = typeof raw?.token === "string" ? raw.token.trim() : "";
    if (!token) return;
    try {
      const sid = storeIdFromJwtToken(token);
      if (sid) socket.join(`store:${sid}`);
    } catch {
      /* ignore */
    }
  });
  setKotSocketEmitter((event, payload) => {
    io.emit(event, payload);
  });

  const shutdown = async (signal: string) => {
    console.log(`[shutdown] ${signal}`);
    await flushAllJsonWriteQueues().catch(() => undefined);
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await closeDatabase().catch(() => undefined);
    await closeMongoQr().catch(() => undefined);
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  httpServer.listen(port, "0.0.0.0", () => {
    console.log(`POS backend listening on port ${port} (all interfaces — use http://<this-machine-LAN-IP>:${port} from phones)`);
  });
})();
