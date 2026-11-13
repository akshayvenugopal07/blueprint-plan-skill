// Blueprint review server.
//
// Security model (see references/security.md):
//  - Node built-ins only. It never connects out; it only answers the browser on 127.0.0.1.
//  - Binds to 127.0.0.1 on a random port. There is no option to bind elsewhere.
//  - The browser needs a session cookie obtained from a single-use launch code.
//  - Host, Origin and Fetch-Metadata are checked on every request.
//  - It serves exactly three static files held in memory, plus plan drafts and
//    validated image attachments. It cannot be asked to read arbitrary paths.
//  - It never executes anything: no child processes, no eval, no plan content
//    is interpreted as code.
//
// The agent never talks to this server over the network. The agent's commands
// (poll, reply, end) exchange small JSON files with it inside the plan's review
// folder, so they work inside sandboxes that block network access.

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import {
  DIST_DIR,
  draftFile,
  ensureStateDir,
  ipc,
  messageFiles,
  pidAlive,
  readJson,
  resolvePlanPath,
  sha256,
  writeFileAtomic,
} from "./paths.mjs";
import { MAX_PLAN_BYTES, parsePlan } from "./schema.mjs";

const IDLE_EXIT_MS = 30 * 60 * 1000; // no browser and no listening agent for 30 minutes
const ENDED_GRACE_MS = 10 * 60 * 1000; // after the user ends: time for the agent to collect the last batch
const LAUNCH_CODE_TTL_MS = 5 * 60 * 1000;
const MAX_JSON_BODY = 512 * 1024;
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const MAX_ATTACHMENTS_PER_ITEM = 4;
const MAX_SESSION_ATTACHMENTS = 60;
const MAX_ITEMS_PER_BATCH = 100;
const MAX_REQUEST_BYTES = 64 * 1024;

const planPath = resolvePlanPath(process.argv[2]);
const stateDir = ensureStateDir(planPath);
const P = ipc(stateDir);

function log(message) {
  try {
    fs.appendFileSync(P.log, `${new Date().toISOString()} ${message}\n`, { mode: 0o600 });
  } catch {
    // Logging is best effort.
  }
}

// Only one server per plan. The CLI already arranges this under a lock; this is the backstop.
{
  const other = readJson(P.server);
  if (other && other.pid !== process.pid && pidAlive(other.pid) && Date.now() - (other.beat || 0) < 8000) {
    log(`another server (pid ${other.pid}) is already serving this plan; exiting`);
    process.exit(0);
  }
}

// ---------------------------------------------------------------------------
// Static assets: loaded once, served from memory, addressed by exact name.
// ---------------------------------------------------------------------------
const STATIC = new Map([
  ["/", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/assets/app.js", { file: "app.js", type: "text/javascript; charset=utf-8" }],
  ["/assets/app.css", { file: "app.css", type: "text/css; charset=utf-8" }],
]);
for (const entry of STATIC.values()) entry.body = fs.readFileSync(path.join(DIST_DIR, entry.file));

const sessionCookieValue = crypto.randomBytes(32).toString("base64url");

function safeEqual(a, b) {
  return crypto.timingSafeEqual(
    crypto.createHash("sha256").update(String(a)).digest(),
    crypto.createHash("sha256").update(String(b)).digest(),
  );
}

// ---------------------------------------------------------------------------
// Persistent review state (this process is its only writer)
// ---------------------------------------------------------------------------
const saved = readJson(P.state, {}) || {};
const state = {
  drafts: Array.isArray(saved.drafts) ? saved.drafts : [], // { n, at, hash }
  batches: Array.isArray(saved.batches) ? saved.batches : [],
  conversation: Array.isArray(saved.conversation) ? saved.conversation : [],
  ended: false, // a fresh server start is always an open (new or resumed) session
  endedBy: null,
  revising: false, // the plan file differs from the latest published draft
  replyError: null, // validation errors from the agent's last rejected reply
};
let version = 1;
const startedAt = Date.now();
let lastBrowserContact = 0;
let exitTimer = null;

function persist() {
  version += 1;
  writeFileAtomic(P.state, JSON.stringify({ drafts: state.drafts, batches: state.batches, conversation: state.conversation }, null, 1));
}

const currentDraft = () => (state.drafts.length ? state.drafts[state.drafts.length - 1].n : 0);
const latestHash = () => (state.drafts.length ? state.drafts[state.drafts.length - 1].hash : null);

function readPlan() {
  try {
    const stat = fs.statSync(planPath);
    if (!stat.isFile()) return { ok: false, errors: ["the plan path is no longer a regular file"] };
    if (stat.size > MAX_PLAN_BYTES) return { ok: false, errors: ["the plan file is too large"] };
    const parsed = parsePlan(fs.readFileSync(planPath));
    if (!parsed.ok) return parsed;
    const normalized = JSON.stringify(parsed.plan);
    return { ok: true, plan: parsed.plan, normalized, hash: sha256(normalized) };
  } catch (error) {
    return { ok: false, errors: [`could not read the plan file: ${error.message}`] };
  }
}

/** Publish the plan file as a new draft if it changed. Drafts are only created here. */
function publishDraft() {
  const read = readPlan();
  if (!read.ok) return read;
  if (read.hash === latestHash()) return { ok: true, changed: false, n: currentDraft() };
  const n = currentDraft() + 1;
  writeFileAtomic(draftFile(stateDir, n), read.normalized);
  state.drafts.push({ n, at: new Date().toISOString(), hash: read.hash });
  state.revising = false;
  persist();
  log(`draft ${n} published`);
  return { ok: true, changed: true, n };
}

/** Called when the plan file changes on disk: the agent is editing. Nothing is published. */
function noticePlanEdit() {
  let hash = null;
  try {
    const raw = fs.readFileSync(planPath);
    const parsed = parsePlan(raw);
    hash = parsed.ok ? sha256(JSON.stringify(parsed.plan)) : `invalid:${sha256(raw)}`;
  } catch {
    return;
  }
  const revising = hash !== latestHash();
  if (revising === state.revising) return;
  state.revising = revising;
  version += 1;
  if (revising) {
    const at = new Date().toISOString();
    let changed = false;
    for (const batch of state.batches) {
      if (batch.seenAt && !batch.workingAt && !batch.doneAt) {
        batch.workingAt = at;
        changed = true;
      }
    }
    if (changed) persist();
  }
}

// ---------------------------------------------------------------------------
// Feedback shaping: only known fields, bounded lengths. Feedback is DATA.
// ---------------------------------------------------------------------------
const clip = (value, max) => (typeof value === "string" ? value.slice(0, max) : undefined);
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ATTACHMENT_ID_RE = /^[a-f0-9]{64}\.(png|jpg|webp)$/;
const TARGET_KINDS = ["general", "block", "text", "diagram", "cell", "item", "decision", "link"];

function shapeItem(raw) {
  if (raw === null || typeof raw !== "object") return null;
  const comment = clip(raw.comment, 8000) ?? "";
  const target = raw.target && typeof raw.target === "object" ? raw.target : {};
  const shaped = {
    comment,
    target: {
      kind: TARGET_KINDS.includes(target.kind) ? target.kind : "general",
      sectionId: ID_RE.test(target.sectionId) ? target.sectionId : undefined,
      blockId: ID_RE.test(target.blockId) ? target.blockId : undefined,
      part: clip(target.part, 120),
      label: clip(target.label, 300),
      quote: clip(target.quote, 1500),
    },
  };
  if (raw.answer && typeof raw.answer === "object") {
    shaped.answer = {
      choices: Array.isArray(raw.answer.choices) ? raw.answer.choices.filter((c) => ID_RE.test(c)).slice(0, 20) : undefined,
      choiceLabels: Array.isArray(raw.answer.choiceLabels)
        ? raw.answer.choiceLabels.map((c) => clip(c, 500)).filter(Boolean).slice(0, 20)
        : undefined,
      text: clip(raw.answer.text, 8000),
    };
  }
  if (Array.isArray(raw.attachments)) {
    shaped.attachments = raw.attachments
      .filter((a) => typeof a === "string" && ATTACHMENT_ID_RE.test(a))
      .slice(0, MAX_ATTACHMENTS_PER_ITEM)
      .filter((a) => fs.existsSync(path.join(P.attachments, a)));
  }
  const hasContent = comment.trim() !== "" || shaped.answer || (shaped.attachments && shaped.attachments.length > 0);
  return hasContent ? shaped : null;
}

function sniffImage(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { ext: "png", mime: "image/png" };
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return { ext: "jpg", mime: "image/jpeg" };
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("latin1") === "RIFF" && buffer.subarray(8, 12).toString("latin1") === "WEBP") {
    return { ext: "webp", mime: "image/webp" };
  }
  return null;
}
const MIME_BY_EXT = { png: "image/png", jpg: "image/jpeg", webp: "image/webp" };

/** Hand a batch to the agent side: one file in inbox/, kept until a poll has printed it. */
function writeInbox(batch) {
  const message = {
    batch: batch.id,
    sent_at: batch.at,
    viewing_draft: batch.draft,
    items: batch.items.map((item, index) => ({
      n: index + 1,
      ...item,
      attachments: item.attachments?.map((a) => path.join(P.attachments, a)),
    })),
  };
  const name = `${Date.now().toString().padStart(15, "0")}-${batch.id}.json`;
  writeFileAtomic(path.join(P.inbox, name), JSON.stringify(message));
}

// ---------------------------------------------------------------------------
// Agent link: requests/, responses/, delivered/
// ---------------------------------------------------------------------------
const REQUEST_NAME_RE = /^[a-f0-9]{16,64}\.json$/;

function processRequests() {
  for (const name of messageFiles(P.requests)) {
    if (!REQUEST_NAME_RE.test(name)) continue;
    const file = path.join(P.requests, name);
    let request = null;
    try {
      if (fs.statSync(file).size <= MAX_REQUEST_BYTES) request = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      // treated as invalid below
    }
    try {
      fs.unlinkSync(file);
    } catch {
      continue; // someone else took it
    }
    const respond = (value) => writeFileAtomic(path.join(P.responses, name), JSON.stringify(value));
    if (!request || typeof request !== "object") {
      respond({ ok: false, error: "invalid request" });
      continue;
    }
    if (request.type === "reply") {
      processDelivered(); // notes the agent has just received count as Seen before they can be marked Done
      const text = clip(request.message, 20_000);
      if (!text || text.trim() === "") {
        respond({ ok: false, error: "the reply message is empty" });
        continue;
      }
      const published = publishDraft();
      if (!published.ok) {
        state.replyError = { at: new Date().toISOString(), errors: published.errors };
        version += 1;
        respond({ ok: false, error: "the plan file is not valid, so nothing was published", errors: published.errors, current_draft: currentDraft() });
        continue;
      }
      const at = new Date().toISOString();
      state.replyError = null;
      state.conversation.push({ id: crypto.randomUUID(), role: "agent", at, draft: published.n, text });
      for (const batch of state.batches) if (batch.seenAt && !batch.doneAt) batch.doneAt = at;
      persist();
      respond({ ok: true, current_draft: published.n, published_new_draft: published.changed });
    } else if (request.type === "end") {
      respond({ ok: true, final_draft: currentDraft() });
      endSession("agent");
    } else if (request.type === "shutdown") {
      respond({ ok: true });
      shutdown("replaced by a new review server");
    } else {
      respond({ ok: false, error: "unknown request type" });
    }
  }
}

/** A poll printed these batches to the agent: that is the "Seen" receipt. */
function processDelivered() {
  let changed = false;
  for (const name of messageFiles(P.delivered)) {
    const match = /-([0-9a-f-]{36})\.json$/.exec(name);
    const batch = match && state.batches.find((b) => b.id === match[1]);
    if (batch && !batch.seenAt) {
      batch.seenAt = new Date().toISOString();
      changed = true;
    }
    try {
      fs.unlinkSync(path.join(P.delivered, name));
    } catch {
      // ignore
    }
  }
  if (changed) persist();
}

function agentListening() {
  const listening = readJson(P.listening);
  return Boolean(listening && Number(listening.until) > Date.now());
}

function heartbeat() {
  // Step aside if a newer server has taken over this plan (only one may serve it).
  const current = readJson(P.server);
  if (current && current.pid !== process.pid && Number(current.startedAt) > startedAt && pidAlive(current.pid)) {
    shutdown(`newer server ${current.pid} took over`);
    return;
  }
  writeFileAtomic(
    P.server,
    JSON.stringify({ pid: process.pid, port, plan: planPath, startedAt, beat: Date.now(), lastBrowserAt: lastBrowserContact || null, ended: state.ended }),
  );
}

// ---------------------------------------------------------------------------
// Ending and shutdown
// ---------------------------------------------------------------------------
function removeAttachments() {
  try {
    for (const name of fs.readdirSync(P.attachments)) if (ATTACHMENT_ID_RE.test(name)) fs.unlinkSync(path.join(P.attachments, name));
  } catch {
    // best effort
  }
}

let shuttingDown = false;
function shutdown(reason, { clean = false } = {}) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`stopping: ${reason}`);
  if (clean) removeAttachments();
  try {
    const current = readJson(P.server);
    if (current && current.pid === process.pid) fs.unlinkSync(P.server);
  } catch {
    // best effort
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}

function scheduleExit(ms, reason) {
  if (exitTimer) clearTimeout(exitTimer);
  exitTimer = setTimeout(() => shutdown(reason, { clean: true }), ms);
}

function endSession(by) {
  if (state.ended) return;
  state.ended = true;
  state.endedBy = by;
  state.conversation.push({
    id: crypto.randomUUID(),
    role: "system",
    at: new Date().toISOString(),
    text: by === "user" ? "You ended the review." : "The agent ended the review.",
  });
  persist();
  writeFileAtomic(P.ended, JSON.stringify({ by, at: new Date().toISOString() }));
  heartbeat();
  log(`session ended by ${by}`);
  scheduleExit(by === "agent" ? 1500 : ENDED_GRACE_MS, by === "agent" ? "ended by agent" : "ended by user (grace elapsed)");
}

// ---------------------------------------------------------------------------
// HTTP (browser only)
// ---------------------------------------------------------------------------
let port = 0;
let allowedHosts = new Set();
let allowedOrigins = new Set();

const SECURITY_HEADERS = {
  "Content-Security-Policy": [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'", // Mermaid writes inline styles into its SVG; scripts stay 'self' only
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join("; "),
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=()",
  "Cache-Control": "no-store",
};

function send(res, status, body, headers = {}) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  res.writeHead(status, { ...SECURITY_HEADERS, "Content-Length": payload.length, ...headers });
  res.end(payload);
}
const sendJson = (res, status, value) => send(res, status, JSON.stringify(value), { "Content-Type": "application/json; charset=utf-8" });
const deny = (res, status, reason) => sendJson(res, status, { error: reason });

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const tooLarge = () => reject(Object.assign(new Error("request body too large"), { status: 413 }));
    if (Number(req.headers["content-length"] || 0) > limit) return tooLarge();
    const chunks = [];
    let size = 0;
    let over = false;
    req.on("data", (chunk) => {
      if (over) return;
      size += chunk.length;
      if (size > limit) {
        over = true;
        chunks.length = 0;
        tooLarge();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!over) resolve(Buffer.concat(chunks));
    });
    req.on("error", reject);
  });
}

async function readJsonBody(req) {
  const type = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json") throw Object.assign(new Error("content-type must be application/json"), { status: 415 });
  const body = await readBody(req, MAX_JSON_BODY);
  try {
    const value = JSON.parse(body.toString("utf8"));
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
    return value;
  } catch {
    throw Object.assign(new Error("invalid JSON body"), { status: 400 });
  }
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0) out[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return out;
}
const cookieName = () => `bp_${port}`;

function hasBrowserSession(req) {
  const value = parseCookies(req.headers.cookie)[cookieName()];
  return typeof value === "string" && value.length > 0 && safeEqual(value, sessionCookieValue);
}

function isTrustedBrowserWrite(req) {
  const origin = req.headers.origin;
  if (!origin || !allowedOrigins.has(origin)) return false;
  if (req.headers["x-blueprint-request"] !== "1") return false;
  const site = req.headers["sec-fetch-site"];
  return site === undefined || site === "same-origin";
}

/** Launch codes are created by the CLI as files named by their SHA-256; each works once. */
function consumeLaunchCode(code) {
  if (typeof code !== "string" || !/^[A-Za-z0-9_-]{20,100}$/.test(code)) return false;
  const file = path.join(P.launch, sha256(code));
  try {
    const age = Date.now() - fs.statSync(file).mtimeMs;
    fs.unlinkSync(file);
    return age >= 0 && age < LAUNCH_CODE_TTL_MS;
  } catch {
    return false;
  }
}

async function handle(req, res) {
  const remote = req.socket.remoteAddress;
  if (remote !== "127.0.0.1" && remote !== "::ffff:127.0.0.1") return deny(res, 403, "loopback only");
  if (!allowedHosts.has(String(req.headers.host || ""))) return deny(res, 403, "unexpected Host header");
  const site = req.headers["sec-fetch-site"];
  if (site !== undefined && site !== "same-origin" && site !== "none") return deny(res, 403, "cross-site request refused");

  let url;
  try {
    url = new URL(req.url, `http://127.0.0.1:${port}`);
  } catch {
    return deny(res, 400, "bad request");
  }
  const route = url.pathname;
  const method = req.method;
  if (method !== "GET" && method !== "POST") return deny(res, 405, "method not allowed");

  if (route === "/launch" && method === "GET") {
    if (!consumeLaunchCode(url.searchParams.get("code"))) {
      return send(res, 403, "This launch link has expired or was already used. Ask your agent to open the review again.", {
        "Content-Type": "text/plain; charset=utf-8",
      });
    }
    return send(res, 303, "", { Location: "/", "Set-Cookie": `${cookieName()}=${sessionCookieValue}; HttpOnly; SameSite=Strict; Path=/` });
  }
  if (route === "/favicon.ico" && method === "GET") return send(res, 204, "");

  if (!hasBrowserSession(req)) {
    return send(res, 403, "Not authorised. Ask your agent to open the review again.", { "Content-Type": "text/plain; charset=utf-8" });
  }
  lastBrowserContact = Date.now();

  if (method === "GET" && STATIC.has(route)) {
    const asset = STATIC.get(route);
    return send(res, 200, asset.body, { "Content-Type": asset.type });
  }

  if (method === "GET" && route === "/api/state") {
    const listening = agentListening();
    return sendJson(res, 200, {
      version: `${version}.${listening ? 1 : 0}`, // the page re-renders when either changes
      planName: path.basename(planPath),
      draft: currentDraft(),
      drafts: state.drafts.map(({ n, at }) => ({ n, at })),
      planError: state.replyError,
      revising: state.revising,
      conversation: state.conversation,
      batches: state.batches.map(({ id, at, draft, items, seenAt, workingAt, doneAt }) => ({ id, at, draft, items, seenAt, workingAt, doneAt })),
      ended: state.ended,
      endedBy: state.endedBy,
      agentListening: listening,
      limits: { attachmentBytes: MAX_ATTACHMENT_BYTES, attachmentsPerItem: MAX_ATTACHMENTS_PER_ITEM },
    });
  }

  const draftMatch = /^\/api\/draft\/(\d{1,6})$/.exec(route);
  if (method === "GET" && draftMatch) {
    const n = Number(draftMatch[1]);
    if (!state.drafts.some((d) => d.n === n)) return deny(res, 404, "no such draft");
    try {
      return send(res, 200, fs.readFileSync(draftFile(stateDir, n)), { "Content-Type": "application/json; charset=utf-8" });
    } catch {
      return deny(res, 404, "draft file missing");
    }
  }

  const attachmentMatch = /^\/api\/attachment\/([a-f0-9]{64}\.(png|jpg|webp))$/.exec(route);
  if (method === "GET" && attachmentMatch) {
    try {
      const body = fs.readFileSync(path.join(P.attachments, attachmentMatch[1]));
      return send(res, 200, body, {
        "Content-Type": MIME_BY_EXT[attachmentMatch[2]],
        "Content-Disposition": "inline",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      });
    } catch {
      return deny(res, 404, "attachment expired");
    }
  }

  if (method === "POST") {
    if (!isTrustedBrowserWrite(req)) return deny(res, 403, "request failed the same-origin checks");

    if (route === "/api/attachment") {
      if (state.ended) return deny(res, 409, "the review has ended");
      const existing = fs.readdirSync(P.attachments).filter((n) => ATTACHMENT_ID_RE.test(n)).length;
      if (existing >= MAX_SESSION_ATTACHMENTS) return deny(res, 409, "attachment limit reached for this review");
      const body = await readBody(req, MAX_ATTACHMENT_BYTES);
      const kind = sniffImage(body);
      if (!kind) return deny(res, 415, "only PNG, JPEG and WebP images are accepted");
      const id = `${sha256(body)}.${kind.ext}`;
      const target = path.join(P.attachments, id);
      if (!fs.existsSync(target)) writeFileAtomic(target, body);
      return sendJson(res, 200, { id, mime: kind.mime, bytes: body.length });
    }

    if (route === "/api/feedback") {
      if (state.ended) return deny(res, 409, "the review has ended");
      const body = await readJsonBody(req);
      const rawItems = Array.isArray(body.items) ? body.items.slice(0, MAX_ITEMS_PER_BATCH) : [];
      const items = rawItems.map(shapeItem).filter(Boolean);
      const end = body.end === true;
      if (items.length === 0 && !end) return deny(res, 400, "nothing to send");
      if (items.length > 0) {
        const batch = {
          id: crypto.randomUUID(),
          at: new Date().toISOString(),
          draft: Number.isInteger(body.draft) ? body.draft : currentDraft(),
          items,
          seenAt: null,
          workingAt: null,
          doneAt: null,
        };
        state.batches.push(batch);
        persist();
        writeInbox(batch);
        log(`feedback batch received (${items.length} item${items.length === 1 ? "" : "s"})`);
      }
      if (end) endSession("user");
      return sendJson(res, 200, { ok: true, accepted: items.length, ended: state.ended });
    }

    if (route === "/api/end") {
      await readJsonBody(req);
      endSession("user");
      return sendJson(res, 200, { ok: true });
    }
  }

  return deny(res, 404, "not found");
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => {
    const status = Number.isInteger(error?.status) ? error.status : 500;
    if (status === 500) log(`error: ${error?.message}`);
    if (res.headersSent) return res.destroy();
    if (status === 413) res.setHeader("Connection", "close");
    deny(res, status, status === 500 ? "internal error" : error.message);
  });
});
server.headersTimeout = 15_000;
server.requestTimeout = 30_000;
server.maxHeadersCount = 60;

server.on("error", (error) => {
  log(`listen error: ${error.code || ""} ${error.message}`);
  process.exit(1);
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
for (const stale of [P.ended, P.listening]) {
  try {
    fs.unlinkSync(stale);
  } catch {
    // none
  }
}
for (const name of messageFiles(P.requests)) {
  try {
    fs.unlinkSync(path.join(P.requests, name)); // requests from a previous server are void
  } catch {
    // ignore
  }
}
{
  const first = publishDraft(); // the CLI validated the file before starting us
  if (!first.ok) {
    log(`plan invalid at start: ${first.errors.join("; ")}`);
    process.exit(1);
  }
}

// 127.0.0.1 and port 0 are hard-coded: there is deliberately no way to change the bind address.
server.listen(0, "127.0.0.1", () => {
  port = server.address().port;
  allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  allowedOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  heartbeat();
  log(`listening on 127.0.0.1:${port}`);
});

fs.watchFile(planPath, { interval: 400, persistent: true }, () => {
  if (!shuttingDown) noticePlanEdit();
});

setInterval(() => {
  if (shuttingDown || !port) return;
  try {
    const owner = readJson(P.server);
    if (owner && owner.pid !== process.pid) return heartbeat(); // not ours: resolve ownership first
    processDelivered();
    processRequests();
  } catch (error) {
    log(`agent link error: ${error.message}`);
  }
}, 250);

setInterval(() => {
  if (!shuttingDown && port) heartbeat();
}, 2000);

setInterval(() => {
  const now = Date.now();
  // Expired launch codes
  try {
    for (const name of fs.readdirSync(P.launch)) {
      const file = path.join(P.launch, name);
      if (now - fs.statSync(file).mtimeMs > LAUNCH_CODE_TTL_MS) fs.unlinkSync(file);
    }
  } catch {
    // ignore
  }
  const browserIdle = now - Math.max(lastBrowserContact, startedAt) > IDLE_EXIT_MS;
  if (browserIdle && !agentListening() && !state.ended) shutdown("idle for 30 minutes");
}, 60_000).unref();

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
