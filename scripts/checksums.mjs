// Writes (--write) or prints the SHA-256 of every file the runtime executes or serves.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FILES = [
  "bin/blueprint.mjs",
  "server/server.mjs",
  "server/schema.mjs",
  "server/paths.mjs",
  "dist/index.html",
  "dist/app.js",
  "dist/app.css",
];
const lines = FILES.map((file) => `${crypto.createHash("sha256").update(fs.readFileSync(path.join(root, file))).digest("hex")}  ${file}`);
const text = `${lines.join("\n")}\n`;
if (process.argv.includes("--write")) {
  fs.writeFileSync(path.join(root, "CHECKSUMS.sha256"), text);
  console.log("CHECKSUMS.sha256 updated");
}
process.stdout.write(text);
