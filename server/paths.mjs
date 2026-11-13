import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DIST_DIR = path.join(SKILL_ROOT, "dist");

/** Folder (inside the current project) where plans live: blueprint/<slug>/<slug>.plan.json */
export const PLANS_DIR_NAME = "blueprint";
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Resolve a user-supplied plan path to a canonical absolute .json path. */
export function resolvePlanPath(input) {
  if (typeof input !== "string" || input.trim() === "") throw new Error("A plan file path is required.");
  const absolute = path.resolve(input);
  if (path.extname(absolute).toLowerCase() !== ".json") {
    throw new Error("The plan file must be a .json file (for example blueprint/checkout/checkout.plan.json).");
  }
  let real;
  try {
    real = fs.realpathSync(absolute);
  } catch {
    throw new Error(`Plan file not found: ${absolute}`);
  }
  if (!fs.statSync(real).isFile()) throw new Error(`Not a regular file: ${real}`);
  return real;
}

/**
 * Review state for a plan. For the standard layout blueprint/<slug>/<slug>.plan.json it is
 * blueprint/<slug>/review/; for a plan anywhere else it is <dir>/.blueprint/<name>/.
 */
export function stateDirFor(planPath) {
  const dir = path.dirname(planPath);
  const base = path.basename(planPath, path.extname(planPath));
  const slug = base.replace(/\.plan$/, "");
  if (path.basename(dir) === slug) return path.join(dir, "review");
  return path.join(dir, ".blueprint", base.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "plan");
}

/** Every file the server and the CLI exchange lives under the state dir. */
export function ipc(dir) {
  return {
    dir,
    state: path.join(dir, "state.json"),
    server: path.join(dir, "server.json"),
    listening: path.join(dir, "listening.json"),
    ended: path.join(dir, "ended.json"),
    lock: path.join(dir, "open.lock"),
    log: path.join(dir, "server.log"),
    drafts: path.join(dir, "drafts"),
    attachments: path.join(dir, "attachments"),
    inbox: path.join(dir, "inbox"), // server -> agent: feedback batches waiting for pickup
    claimed: path.join(dir, "claimed"), // a poll has taken the batch but not yet printed it
    delivered: path.join(dir, "delivered"), // printed to the agent; server turns these into "Seen" receipts
    requests: path.join(dir, "requests"), // agent -> server: reply, end, shutdown
    responses: path.join(dir, "responses"),
    launch: path.join(dir, "launch"), // hashed single-use browser launch codes
  };
}

export function ensureStateDir(planPath) {
  const dir = stateDirFor(planPath);
  const p = ipc(dir);
  for (const sub of [p.drafts, p.attachments, p.inbox, p.claimed, p.delivered, p.requests, p.responses, p.launch]) {
    fs.mkdirSync(sub, { recursive: true, mode: 0o700 });
  }
  // Keep review state out of version control.
  const ignore = path.join(dir, ".gitignore");
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, "*\n", { mode: 0o600 });
  return dir;
}

export function draftFile(dir, n) {
  return path.join(dir, "drafts", `draft-${String(n).padStart(4, "0")}.json`);
}

export function writeFileAtomic(file, data, mode = 0o600) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
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

/** Files in a directory that are complete JSON messages (never temp files), oldest name first. */
export function messageFiles(dir) {
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => /^[A-Za-z0-9._~-]+\.json$/.test(name) && !name.includes(".tmp"))
      .sort();
  } catch {
    return [];
  }
}

export function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

/** Is process `pid` alive? EPERM means it exists but belongs to a sandbox we cannot signal. */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}
