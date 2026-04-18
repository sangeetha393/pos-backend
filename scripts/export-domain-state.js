const fs = require("fs");
const path = require("path");
const p = path.join(__dirname, "../src/routes/domainState.ts");
const lines = fs.readFileSync(p, "utf8").split(/\r?\n/);
const out = lines.map((line) => {
  const t = line.trimStart();
  if (line.startsWith("import ") || line.startsWith("export ") || line.startsWith("//") || line.trim() === "") {
    return line;
  }
  if (/^(let|const|function|type|interface)\s/.test(t)) {
    const pad = line.slice(0, line.length - t.length);
    if (pad.length === 0) return `export ${t}`;
    if (pad === "  ") return `export ${t}`;
    return line;
  }
  return line;
});
fs.writeFileSync(p, out.join("\n"));
console.log("exports added");
