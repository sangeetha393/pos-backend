const fs = require("fs");
const path = require("path");
const src = path.join(__dirname, "../src/routes.ts");
let s = fs.readFileSync(src, "utf8");

s = s.replace(
  /import \{ Express, Request, Response \} from "express";/,
  'import { Express, Request, Response, Router } from "express";\nimport { authMiddleware } from "./middleware/auth.middleware";'
);

s = s.replace(
  `export function registerRoutes(app: Express) {
  app.get("/health"`,
  `export function registerRoutes(app: Express) {
  const pub = Router();
  const prot = Router();

  pub.get("/health"`
);

s = s.replace(/\bapp\.(get|post|put|patch|delete)\(/g, "prot.$1(");

const pubFixes = [
  [/prot\.get\("\/health"/g, 'pub.get("/health"'],
  [/prot\.(get|post|put|patch|delete)\("\/auth/g, "pub.$1(\"/auth"],
  [/prot\.get\("\/products", \(_req, res\) =>/g, 'pub.get("/products", (_req, res) =>'],
  [/prot\.post\("\/orders",/g, 'pub.post("/orders",'],
  [/prot\.post\("\/waiter-calls",/g, 'pub.post("/waiter-calls",'],
  [/prot\.get\("\/kots\/:id",/g, 'pub.get("/kots/:id",']
];
for (const [re, to] of pubFixes) s = s.replace(re, to);

const tailNeedle = `    res.json({
      totalItems,
      totalValue,
      totalStock,
      lowStockCount: lowStockItems.length,
      lowStockItems,
      inventoryByCategory,
      topValueItems
    });
  });
}`;

const tailReplace = `    res.json({
      totalItems,
      totalValue,
      totalStock,
      lowStockCount: lowStockItems.length,
      lowStockItems,
      inventoryByCategory,
      topValueItems
    });
  });

  app.use("/api", pub);
  app.use("/api", authMiddleware, prot);
}`;

if (!s.includes("app.use(\"/api\", pub)")) {
  if (!s.includes(tailNeedle)) {
    throw new Error("Tail needle not found — routes.ts layout changed");
  }
  s = s.replace(tailNeedle, tailReplace);
}

fs.writeFileSync(src, s);
console.log("Transformed", src);
