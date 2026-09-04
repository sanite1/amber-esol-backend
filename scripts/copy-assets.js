/**
 * Post-compile asset copy. `tsc` only emits .ts -> .js; every non-TS
 * file under src/ (data JSON banks, scenario files, system-prompt
 * markdown, email .hbs templates, CSV samples) must be copied into
 * dist/ at the same relative path, because services resolve them via
 * __dirname at runtime. Runs as part of `npm run build`.
 */
const fs = require("fs");

fs.cpSync("src", "dist", {
  recursive: true,
  force: true,
  filter: (src) => !src.endsWith(".ts") && !src.includes(".DS_Store"),
});

console.log("copy-assets: non-TS files from src/ copied into dist/");
