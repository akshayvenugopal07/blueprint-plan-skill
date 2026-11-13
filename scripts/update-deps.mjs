// Update the pinned build-time packages. Nothing here runs unless YOU run it.
//
//   npm run update:deps                 Show what is outdated and any known vulnerabilities (changes nothing)
//   npm run update:deps -- mermaid      Update one package to its latest version, rebuild, re-test, re-checksum
//   npm run update:deps -- mermaid@12.3.1   ...or to an exact version
//   npm run update:deps -- --all        Update every package
//
// This is the only part of the skill that uses the network (the npm registry),
// and only at the moment you run it. Review the printed version changes before
// trusting the new build; `git diff package.json package-lock.json` shows them.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const run = (args, options = {}) => execFileSync(npm, args, { cwd: root, stdio: "inherit", ...options });
const capture = (args) => {
  try {
    return execFileSync(npm, args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  } catch (error) {
    return error.stdout || ""; // npm outdated / audit exit non-zero when they have findings
  }
};
const pkg = () => JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const known = Object.keys(pkg().devDependencies);
const args = process.argv.slice(2);

if (!fs.existsSync(path.join(root, "node_modules"))) {
  console.log("Installing the pinned packages from package-lock.json (integrity-checked, install scripts disabled)...");
  run(["ci", "--ignore-scripts", "--no-fund"]);
}

if (args.length === 0) {
  console.log("\nOutdated packages:\n" + (capture(["outdated"]) || "  none\n"));
  console.log("Known vulnerabilities:\n" + capture(["audit"]));
  console.log("Nothing was changed. To update: npm run update:deps -- <package>   or   -- --all");
  process.exit(0);
}

const targets = args.includes("--all") ? known.map((name) => `${name}@latest`) : args.map((arg) => (arg.lastIndexOf("@") > 0 ? arg : `${arg}@latest`));
for (const target of targets) {
  const name = target.slice(0, target.lastIndexOf("@"));
  if (!known.includes(name)) {
    console.error(`"${name}" is not one of this skill's packages (${known.join(", ")}). Adding new packages is deliberately a manual, reviewed change.`);
    process.exit(1);
  }
}

const before = pkg().devDependencies;
run(["install", "--save-dev", "--save-exact", "--ignore-scripts", "--no-fund", ...targets]);
const after = pkg().devDependencies;
console.log("\nVersion changes:");
for (const name of known) if (before[name] !== after[name]) console.log(`  ${name}: ${before[name]} -> ${after[name]}`);
console.log("\nAudit:\n" + capture(["audit"]));
run(["run", "build"]);
run(["test"]);
run(["run", "checksums"]);
console.log("\nDone. dist/ was rebuilt and CHECKSUMS.sha256 updated. Review the changes above before using the skill.");
