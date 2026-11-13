// Builds dist/ from app/ using the pinned packages in node_modules.
// Run only when you change the app or update a package: `npm run build`.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
fs.mkdirSync(dist, { recursive: true });

await build({
  entryPoints: [path.join(root, "app/src/main.jsx")],
  outfile: path.join(dist, "app.js"),
  bundle: true,
  splitting: false, // one file: nothing is ever fetched lazily from anywhere
  format: "iife",
  platform: "browser",
  target: ["es2022"],
  minify: true,
  legalComments: "none",
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
  logLevel: "warning",
});

execFileSync(
  process.execPath,
  [
    path.join(root, "node_modules/@tailwindcss/cli/dist/index.mjs"),
    "-i", path.join(root, "app/src/styles.css"),
    "-o", path.join(dist, "app.css"),
    "--minify",
  ],
  { stdio: "inherit", cwd: root },
);

fs.copyFileSync(path.join(root, "app/index.html"), path.join(dist, "index.html"));

// Third-party licence texts for everything bundled into dist/app.js.
const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
const notices = ["Third-party software bundled in dist/ (name, version, licence, integrity):", ""];
for (const [key, info] of Object.entries(lock.packages)) {
  if (!key) continue;
  notices.push(`${key.replace(/^.*node_modules\//, "")}@${info.version}  ${info.license || "see package"}  ${info.integrity || ""}`);
}
fs.writeFileSync(path.join(root, "THIRD-PARTY.txt"), `${notices.join("\n")}\n`);

for (const file of ["app.js", "app.css", "index.html"]) {
  console.log(`${file}  ${(fs.statSync(path.join(dist, file)).size / 1024).toFixed(0)} KB`);
}
