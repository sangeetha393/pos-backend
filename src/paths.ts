import fs from "fs";
import path from "path";

/**
 * Directory containing backend `package.json`, `data/`, `uploads/`, `.env`.
 * Works when `process.cwd()` is the monorepo root or `backend/`.
 */
function resolveBackendRoot(): string {
  const fromSourceTree = path.resolve(__dirname, "..");
  if (fs.existsSync(path.join(fromSourceTree, "package.json"))) {
    return fromSourceTree;
  }
  const fromRepoRoot = path.resolve(process.cwd(), "backend");
  if (fs.existsSync(path.join(fromRepoRoot, "package.json"))) {
    return fromRepoRoot;
  }
  return fromSourceTree;
}

export const BACKEND_ROOT = resolveBackendRoot();
/**
 * Per-deployment data root. Use a different folder for each hotel when running multiple
 * isolated instances on one machine (one process per hotel recommended).
 * Example: `POS_DATA_DIR=C:\\pos-data\\hotel-a`
 */
export const DATA_DIR = process.env.POS_DATA_DIR
  ? path.resolve(process.env.POS_DATA_DIR)
  : path.join(BACKEND_ROOT, "data");
export const UPLOADS_DIR = path.join(BACKEND_ROOT, "uploads");
