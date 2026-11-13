import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DIST_DIR = path.join(SKILL_ROOT, "dist");

/** Resolve a user-supplied plan path to a canonical absolute .json path. */
export function resolvePlanPath(input) {
  if (typeof input !== "string" || input.trim() === "") throw new Error("A plan file path is required.");
  const absolute = path.resolve(input);
  if (path.extname(absolute).toLowerCase() !== ".json") {
    throw new Error("The plan file must be a .json file (for example plans/checkout.plan.json).");
  }
  let real;
  try {
    real = fs.realpathSync(absolute);
  } catch {
    throw new Error(`Plan file not found: ${absolute}`);
  }
  const stat = fs.statSync(real);
  if (!stat.isFile()) throw new Error(`Not a regular file: ${real}`);
  return real;
}

/** All review state for a plan lives beside it, inside the project. */
export function stateDirFor(planPath) {
  const base = path
    .basename(planPath, path.extname(planPath))
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .slice(0, 80);
  return path.join(path.dirname(planPath), ".blueprint", base || "plan");
}

export function ensureStateDir(planPath) {
  const dir = stateDirFor(planPath);
  fs.mkdirSync(path.join(dir, "drafts"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(dir, "attachments"), { recursive: true, mode: 0o700 });
  // Keep review state (tokens, drafts, images) out of version control.
  const ignore = path.join(path.dirname(dir), ".gitignore");
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, "*\n", { mode: 0o600 });
  return dir;
}

export function writeFileAtomic(file, data, mode = 0o600) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, { mode });
  fs.renameSync(tmp, file);
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}
