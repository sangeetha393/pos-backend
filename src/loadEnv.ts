import * as dotenv from "dotenv";
import path from "path";
import { BACKEND_ROOT } from "./paths";

const envPath = path.join(BACKEND_ROOT, ".env");
const result = dotenv.config({ path: envPath });
if (result.error && process.env.NODE_ENV !== "test") {
  console.warn("[env] Could not load", envPath, "—", result.error.message);
}
