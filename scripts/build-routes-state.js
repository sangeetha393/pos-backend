const fs = require("fs");
const path = require("path");
const routesPath = path.join(__dirname, "../src/routes.ts");
const outPath = path.join(__dirname, "../src/routesState.ts");
const L = fs.readFileSync(routesPath, "utf8").split(/\r?\n/);
function pick(a, b) {
  return L.slice(a - 1, b).join("\n");
}
const head = L.slice(0, 1117).join("\n");
const lifted = [
  "// --- lifted from former registerRoutes closure ---",
  pick(1382, 1403),
  pick(1434, 1494),
  pick(1577, 1604),
  pick(1671, 1703),
  pick(1835, 1855),
  pick(1886, 1892),
  pick(2477, 2485),
  pick(3199, 3205),
  pick(3228, 3246),
  pick(3368, 3391),
  pick(3430, 3457)
].join("\n\n");
fs.writeFileSync(outPath, `${head}\n\n${lifted}\n`);
console.log("Wrote", outPath);
