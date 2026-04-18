const fs = require("fs");
const path = require("path");
const p = path.join(__dirname, "../src/routesState.ts");
let s = fs.readFileSync(p, "utf8");
const lines = s.split(/\r?\n/);
const out = lines.map((line) => {
  if (line.startsWith("import ") || line.startsWith("//") || line.trim() === "") return line;
  const t = line.trimStart();
  if (/^(let|const|function|type|interface)\s/.test(t) && !line.includes(" export ")) {
    const pad = line.slice(0, line.length - t.length);
    if (pad.length >= 2) {
      return pad.slice(0, -2) + "export " + t;
    }
    return "export " + t;
  }
  return line;
});
fs.writeFileSync(p, out.join("\n"));
console.log("Done");
