/**
 * When the process is started as `node server.js`, load the compiled Express app.
 * The real POS API lives in `src/index.ts` → `dist/index.js` (includes GET /api/products/pos).
 * Run `npm run build` before starting in production.
 */
require("./dist/index.js");
