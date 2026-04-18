import type { Server } from "socket.io";
import type { StoreFeatures } from "./storeFeatureModel";

let io: Server | null = null;

export function attachStoreFeatureIo(server: Server): void {
  io = server;
}

export function emitStoreFeaturesUpdated(storeId: string, features: StoreFeatures): void {
  if (!io) return;
  io.to(`store:${storeId}`).emit("store-features", { storeId, features });
  io.emit("store-features-updated", { storeId, features });
}
