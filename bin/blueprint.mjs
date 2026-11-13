#!/usr/bin/env node
// Blueprint CLI. Node built-ins only. Talks to the review server on 127.0.0.1
// and nowhere else. The only processes it ever starts are (1) the review
// server in this same skill folder and (2) the system's "open this URL in the
// default browser" helper, both without a shell.

import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { DIST_DIR, SKILL_ROOT, ensureStateDir, readJson, resolvePlanPath, stateDirFor, writeFileAtomic } from "../server/paths.mjs";
import { parsePlan } from "../server/schema.mjs";

const HELP = `blueprint - local plan review (nothing leaves this machine)

  blueprint open <plan.json> [--no-browser]   Validate the plan, start the review, open the browser
  blueprint poll <plan.json> [--wait <sec>]   Wait for the user's next feedback batch (default 540s)
  blueprint reply <plan.json> --message "..." Show a short reply in the review after revising
                          or --message-file <path>
  blueprint end <plan.json>                   End the review from the agent side
  blueprint status <plan.json>                Is a review open? Which draft? Anything undelivered?
  blueprint validate <plan.json>              Check a plan file without opening anything
  blueprint export <plan.json> [--out <file>] Write one self-contained HTML file (no server needed)
  blueprint verify                            Check the skill's files against CHECKSUMS.sha256

Plans are JSON data described in references/plan-schema.md.`;

function out(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function fail(message, extra = {}) {
  out({ status: "error", error: message, ...extra });
  process.exit(1);
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--no-browser") flags.noBrowser = true;
    else if (arg === "--wait" || arg === "--message" || arg === "--message-file" || arg === "--out") {
      if (i + 1 >= argv.length) fail(`${arg} needs a value`);
      flags[arg.slice(2)] = argv[i + 1];
      i += 1;
    } else if (arg.startsWith("--")) fail(`unknown option ${arg}`);
    else positional.push(arg);
  }
  return { positional, flags };
}

// ---------------------------------------------------------------------------
// Integrity: refuse to run a review from files that do not match the manifest.
// ---------------------------------------------------------------------------
export function verifyIntegrity() {
  const manifestPath = path.join(SKILL_ROOT, "CHECKSUMS.sha256");
  if (!fs.existsSync(manifestPath)) return { ok: false, problems: ["CHECKSUMS.sha256 is missing"] };
  const problems = [];
  let checked = 0;
  for (const line of fs.readFileSync(manifestPath, "utf8").split("\n")) {
    const match = /^([a-f0-9]{64}) {2}(.+)$/.exec(line.trim());
    if (!match) continue;
    const [, expected, relative] = match;
    const file = path.join(SKILL_ROOT, relative);
    if (!fs.existsSync(file)) {
      problems.push(`missing: ${relative}`);
      continue;
    }
    const actual = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    if (actual !== expected) problems.push(`modified: ${relative}`);
    checked += 1;
  }
  if (checked === 0) problems.push("CHECKSUMS.sha256 lists no files");
  return { ok: problems.length === 0, problems, checked };
}

function requireIntegrity() {
  const result = verifyIntegrity();
  if (!result.ok) {
    fail("Integrity check failed: the skill's files do not match CHECKSUMS.sha256. Refusing to start.", {
      problems: result.problems,
      next_step:
        "Tell the user exactly which files differ and stop. If the user changed these files on purpose, they can run `npm run checksums` in the skill folder to accept the new contents. Do not run that for them without being asked.",
    });
  }
}

// ---------------------------------------------------------------------------
// Local HTTP to the review server (127.0.0.1 only)
// ---------------------------------------------------------------------------
function request(session, method, route, { body, timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        host: "127.0.0.1", // hard-coded: the CLI cannot be pointed at another machine
        port: session.port,
        method,
        path: route,
        headers: {
          Authorization: `Bearer ${session.token}`,
          ...(payload ? { "Content-Type": "application/json", "Content-Length": payload.length } : {}),
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            // leave null
          }
          resolve({ status: res.statusCode, json });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function readSession(planPath) {
  const session = readJson(path.join(stateDirFor(planPath), "session.json"));
  if (!session || !Number.isInteger(session.port) || typeof session.token !== "string") return null;
  if (session.plan !== planPath) return null;
  return session;
}

async function liveSession(planPath) {
  const session = readSession(planPath);
  if (!session) return null;
  try {
    const res = await request(session, "GET", "/cli/status", { timeoutMs: 2500 });
    if (res.status === 200 && res.json?.plan === planPath) return { session, status: res.json };
  } catch {
    // not running
  }
  return null;
}

async function startServer(planPath) {
  const stateDir = ensureStateDir(planPath);
  const sessionFile = path.join(stateDir, "session.json");
  try {
    fs.unlinkSync(sessionFile);
  } catch {
    // none
  }
  const logFd = fs.openSync(path.join(stateDir, "server.log"), "a", 0o600);
  const child = spawn(process.execPath, [path.join(SKILL_ROOT, "server", "server.mjs"), planPath], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    cwd: SKILL_ROOT,
    env: { PATH: process.env.PATH || "", HOME: process.env.HOME || "", TZ: process.env.TZ || "", SystemRoot: process.env.SystemRoot || "" },
    windowsHide: true,
  });
  child.unref();
  fs.closeSync(logFd);
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 120));
    const live = await liveSession(planPath);
    if (live) return live;
  }
  throw new Error(`The review server did not start. See ${path.join(stateDir, "server.log")}`);
}

function openBrowser(url) {
  return new Promise((resolve) => {
    let command;
    let args;
    if (process.platform === "darwin") {
      command = "/usr/bin/open";
      args = [url];
    } else if (process.platform === "win32") {
      command = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "rundll32.exe");
      args = ["url.dll,FileProtocolHandler", url];
    } else {
      command = "xdg-open";
      args = [url];
    }
    execFile(command, args, { timeout: 8000, windowsHide: true }, (error) => resolve(!error));
  });
}

function loadPlan(planPath) {
  return parsePlan(fs.readFileSync(planPath));
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------
async function cmdOpen(args) {
  const planPath = resolvePlanPath(args.positional[0]);
  requireIntegrity();
  const parsed = loadPlan(planPath);
  if (!parsed.ok) {
    fail("The plan file is not valid, so nothing was opened.", {
      errors: parsed.errors,
      next_step: "Fix these errors (see references/plan-schema.md), then run blueprint open again.",
    });
  }
  let live = await liveSession(planPath);
  let resumed = true;
  if (!live || live.status.status === "ended") {
    resumed = false;
    if (live) await new Promise((resolve) => setTimeout(resolve, 1800)); // let an ended server finish exiting
    live = await startServer(planPath);
  }
  const launch = await request(live.session, "POST", "/cli/launch", { body: {} });
  if (launch.status !== 200) fail("Could not create a launch link.", { detail: launch.json });
  const url = `http://127.0.0.1:${live.session.port}/launch?code=${launch.json.code}`;
  let opened = false;
  if (!args.flags.noBrowser) opened = await openBrowser(url);
  out({
    status: "open",
    plan: planPath,
    resumed,
    current_draft: live.status.current_draft,
    browser_opened: opened,
    ...(opened
      ? {}
      : {
          launch_url: url,
          launch_note:
            "Give this link to the user to open on THIS machine. It works once and expires in 5 minutes; run blueprint open again for a new one.",
        }),
    next_step:
      `Do not summarise the plan in chat yet. Run: blueprint poll ${JSON.stringify(planPath)}  (allow it up to 10 minutes; ` +
      `it is silent while the user reads - never kill it). When it returns "waiting", run it again.`,
  });
}

async function cmdPoll(args) {
  const planPath = resolvePlanPath(args.positional[0]);
  const live = await liveSession(planPath);
  if (!live) {
    out({
      status: "not_running",
      plan: planPath,
      next_step:
        "No review is open for this plan (it ended, or the server stopped after 30 idle minutes). Ask the user whether they want it reopened; if yes run blueprint open <plan>.",
    });
    return;
  }
  const wait = Math.min(Math.max(Number(args.flags.wait) || 540, 1), 590);
  try {
    const res = await request(live.session, "GET", `/cli/poll?wait=${wait}`, { timeoutMs: (wait + 15) * 1000 });
    out(res.json ?? { status: "error", error: `unexpected response ${res.status}` });
  } catch (error) {
    out({ status: "interrupted", error: error.message, next_step: "Run blueprint poll <plan> again. Sent feedback is kept until delivered." });
  }
}

async function cmdReply(args) {
  const planPath = resolvePlanPath(args.positional[0]);
  let message = args.flags.message;
  if (args.flags["message-file"]) {
    const file = path.resolve(args.flags["message-file"]);
    const stat = fs.statSync(file);
    if (stat.size > 64 * 1024) fail("--message-file is larger than 64 KB");
    message = fs.readFileSync(file, "utf8");
  }
  if (!message || message.trim() === "") fail("A reply needs --message or --message-file.");
  const live = await liveSession(planPath);
  if (!live) fail("No review is open for this plan.", { next_step: "Give the update in chat instead." });
  const res = await request(live.session, "POST", "/cli/reply", { body: { message } });
  if (res.status !== 200) fail("Reply was not accepted.", { detail: res.json });
  out({ status: "replied", ...res.json });
}

async function cmdEnd(args) {
  const planPath = resolvePlanPath(args.positional[0]);
  const live = await liveSession(planPath);
  if (!live) return out({ status: "not_running", plan: planPath });
  await request(live.session, "POST", "/cli/end", { body: {} });
  out({ status: "ended", plan: planPath, final_draft: live.status.current_draft });
}

async function cmdStatus(args) {
  const planPath = resolvePlanPath(args.positional[0]);
  const live = await liveSession(planPath);
  const drafts = readJson(path.join(stateDirFor(planPath), "state.json"), {})?.drafts ?? [];
  if (!live) return out({ status: "not_running", plan: planPath, drafts_recorded: drafts.length });
  out(live.status);
}

function cmdValidate(args) {
  const planPath = resolvePlanPath(args.positional[0]);
  const parsed = loadPlan(planPath);
  if (!parsed.ok) fail("The plan file is not valid.", { errors: parsed.errors });
  const blocks = parsed.plan.sections.reduce((sum, s) => sum + s.blocks.length, 0);
  out({ status: "valid", plan: planPath, sections: parsed.plan.sections.length, blocks });
}

async function cmdExport(args) {
  const planPath = resolvePlanPath(args.positional[0]);
  requireIntegrity();
  const parsed = loadPlan(planPath);
  if (!parsed.ok) fail("The plan file is not valid.", { errors: parsed.errors });
  // Record this version as a draft (same files the review server uses), so the draft
  // counter and change markers also work when reviewing through exported files.
  let drafts;
  let recent;
  if (await liveSession(planPath)) {
    await new Promise((resolve) => setTimeout(resolve, 900)); // let the running server record the latest edit
    drafts = readJson(path.join(stateDirFor(planPath), "state.json"), {})?.drafts ?? [];
  } else {
    const stateDir = ensureStateDir(planPath);
    const stateFile = path.join(stateDir, "state.json");
    const state = readJson(stateFile, {}) || {};
    drafts = Array.isArray(state.drafts) ? state.drafts : [];
    const normalized = JSON.stringify(parsed.plan);
    const hash = crypto.createHash("sha256").update(normalized).digest("hex");
    if (!drafts.length || drafts[drafts.length - 1].hash !== hash) {
      const n = (drafts.length ? drafts[drafts.length - 1].n : 0) + 1;
      writeFileAtomic(path.join(stateDir, "drafts", `draft-${String(n).padStart(4, "0")}.json`), normalized);
      drafts.push({ n, at: new Date().toISOString(), hash });
      writeFileAtomic(stateFile, JSON.stringify({ ...state, drafts }, null, 1));
    }
  }
  const draft = drafts.length ? drafts[drafts.length - 1].n : 1;
  recent = {};
  for (const entry of drafts.slice(-4)) {
    const stored = readJson(path.join(stateDirFor(planPath), "drafts", `draft-${String(entry.n).padStart(4, "0")}.json`));
    if (stored) recent[entry.n] = stored;
  }
  recent[draft] = parsed.plan;
  const css = fs.readFileSync(path.join(DIST_DIR, "app.css"), "utf8").replace(/<\/style/gi, "<\\/style");
  // Make the bundle safe to place inside <script>: it must not contain a closing tag or an HTML comment opener.
  const js = fs
    .readFileSync(path.join(DIST_DIR, "app.js"), "utf8")
    .replace(/<\/script/gi, "<\\/script")
    .replace(/<!--/g, "<\\!--");
  const data = JSON.stringify({
    plans: recent,
    draft,
    drafts: (drafts.length ? drafts : [{ n: 1, at: null }]).map(({ n, at }) => ({ n, at })),
    planName: path.basename(planPath),
  })
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  const scriptHash = crypto.createHash("sha256").update(js).digest("base64");
  const csp = [
    "default-src 'none'",
    `script-src 'sha256-${scriptHash}'`,
    "style-src 'unsafe-inline'",
    "img-src data: blob:",
    "font-src data:",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
  const title = String(parsed.plan.title).replace(/[<>&"]/g, " ");
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="referrer" content="no-referrer">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} - Blueprint</title>
<style>${css}</style>
</head>
<body>
<div id="root"></div>
<script type="application/json" id="blueprint-static">${data}</script>
<script>${js}</script>
</body>
</html>
`;
  const output = args.flags.out
    ? path.resolve(args.flags.out)
    : path.join(path.dirname(planPath), `${path.basename(planPath, ".json")}.export.html`);
  if (path.extname(output).toLowerCase() !== ".html") fail("--out must end in .html");
  fs.writeFileSync(output, html);
  out({
    status: "exported",
    file: output,
    draft,
    bytes: Buffer.byteLength(html),
    next_step:
      "This single file opens with no server and makes no network requests. The reader can annotate it and use Copy feedback to paste their notes back into chat.",
  });
}

function cmdVerify() {
  const result = verifyIntegrity();
  if (!result.ok) fail("Integrity check failed.", { problems: result.problems });
  out({ status: "verified", files_checked: result.checked });
}

const [command, ...rest] = process.argv.slice(2);
const args = parseArgs(rest);
const commands = {
  open: cmdOpen,
  poll: cmdPoll,
  reply: cmdReply,
  end: cmdEnd,
  status: cmdStatus,
  validate: cmdValidate,
  export: cmdExport,
  verify: cmdVerify,
};

if (!command || command === "help" || command === "--help" || command === "-h") {
  process.stdout.write(`${HELP}\n`);
} else if (!Object.hasOwn(commands, command)) {
  fail(`unknown command "${command}"`, { help: HELP });
} else {
  try {
    await commands[command](args);
  } catch (error) {
    fail(error?.message || String(error));
  }
}
