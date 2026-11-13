// Hardening tests for the review server. Run with: npm test
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { validatePlan } from "../server/schema.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(root, "bin/blueprint.mjs");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blueprint-test-"));
const planPath = path.join(dir, "t.plan.json");
const plan = { blueprint: 1, title: "T", sections: [{ id: "s", title: "S", blocks: [{ id: "b", type: "markdown", text: "hi" }] }] };
const cli = (...args) => JSON.parse(execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8" }));
let port;
let launchUrl;
let cookie;

function req({ method = "GET", route = "/", headers = {}, body, host }) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port, method, path: route, headers: { ...(host ? { Host: host } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
    });
    r.on("error", reject);
    if (body) r.write(body);
    r.end();
  });
}

before(() => {
  fs.writeFileSync(planPath, JSON.stringify(plan));
  const opened = cli("open", planPath, "--no-browser");
  launchUrl = new URL(opened.launch_url);
  port = Number(launchUrl.port);
});
after(() => {
  try {
    cli("end", planPath);
  } catch {
    // already stopped
  }
});

test("integrity manifest matches shipped files", () => {
  assert.equal(cli("verify").status, "verified");
});

test("review folder is private to the owner", { skip: process.platform === "win32" }, () => {
  assert.equal(fs.statSync(path.join(dir, ".blueprint/t.plan/inbox")).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(dir, ".blueprint/t.plan/server.json")).mode & 0o777, 0o600);
});

test("no page or API without a session cookie", async () => {
  for (const route of ["/", "/assets/app.js", "/api/state", "/api/draft/1"]) {
    assert.equal((await req({ route })).status, 403, route);
  }
});

test("wrong Host header is refused (DNS rebinding)", async () => {
  assert.equal((await req({ route: "/", host: "evil.example" })).status, 403);
});

test("launch code works exactly once and sets an HttpOnly, SameSite=Strict cookie", async () => {
  const first = await req({ route: launchUrl.pathname + launchUrl.search });
  assert.equal(first.status, 303);
  const set = first.headers["set-cookie"][0];
  assert.match(set, /HttpOnly/);
  assert.match(set, /SameSite=Strict/);
  cookie = set.split(";")[0];
  assert.equal((await req({ route: launchUrl.pathname + launchUrl.search })).status, 403);
  assert.equal((await req({ route: "/launch?code=guess" })).status, 403);
});

test("pages carry a strict Content-Security-Policy and no-sniff headers", async () => {
  const res = await req({ route: "/", headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const csp = res.headers["content-security-policy"];
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'self'(;|$)/);
  assert.doesNotMatch(csp, /unsafe-eval/);
  assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/);
  assert.match(csp, /connect-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(res.headers["x-content-type-options"], "nosniff");
  assert.equal(res.headers["x-frame-options"], "DENY");
});

test("cross-site and forged writes are refused", async () => {
  const body = JSON.stringify({ items: [{ comment: "x", target: { kind: "general" } }] });
  const base = { Cookie: cookie, "Content-Type": "application/json" };
  const good = { ...base, Origin: `http://127.0.0.1:${port}`, "X-Blueprint-Request": "1" };
  const post = (headers) => req({ method: "POST", route: "/api/feedback", headers, body });
  assert.equal((await post(base)).status, 403, "no Origin");
  assert.equal((await post({ ...good, Origin: "https://evil.example" })).status, 403, "foreign Origin");
  assert.equal((await post({ ...base, Origin: `http://127.0.0.1:${port}` })).status, 403, "missing custom header");
  assert.equal((await post({ ...good, "Sec-Fetch-Site": "cross-site" })).status, 403, "cross-site fetch metadata");
  assert.equal((await post({ ...good, "Content-Type": "text/plain" })).status, 415, "wrong content type");
  assert.equal((await req({ route: "/api/state", headers: { Cookie: cookie, "Sec-Fetch-Site": "cross-site" } })).status, 403, "cross-site read");
  assert.equal((await post(good)).status, 200, "legitimate write");
});

test("there are no agent routes over HTTP", async () => {
  for (const route of ["/cli/status", "/cli/poll", "/cli/reply", "/cli/launch"]) {
    assert.equal((await req({ route, headers: { Cookie: cookie } })).status, 404, route);
  }
});

test("no path traversal or arbitrary file reads", async () => {
  const headers = { Cookie: cookie };
  for (const route of ["/assets/../server/server.mjs", "/assets/%2e%2e/package.json", "/api/draft/..%2f..%2fstate", "/api/attachment/../../session.json", "/etc/passwd", "/assets/app.js.map"]) {
    const res = await req({ route, headers });
    assert.ok(res.status === 404 || res.status === 400, `${route} -> ${res.status}`);
    assert.doesNotMatch(res.text, /token/);
  }
});

test("uploads must really be images and are size-capped", async () => {
  const headers = { Cookie: cookie, Origin: `http://127.0.0.1:${port}`, "X-Blueprint-Request": "1", "Content-Type": "image/png" };
  const up = (body, extra = {}) => req({ method: "POST", route: "/api/attachment", headers: { ...headers, ...extra }, body });
  assert.equal((await up(Buffer.from("<script>alert(1)</script>"))).status, 415);
  const big = await up(Buffer.alloc(6 * 1024 * 1024)).catch(() => ({ status: 413 })); // refused mid-upload
  assert.equal(big.status, 413);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
  const ok = await up(png);
  assert.equal(ok.status, 200);
  const id = JSON.parse(ok.text).id;
  const served = await req({ route: `/api/attachment/${id}`, headers: { Cookie: cookie } });
  assert.equal(served.headers["content-type"], "image/png");
  assert.match(served.headers["content-security-policy"], /sandbox/);
});

test("feedback is reduced to known fields and delivered with a handling note", async () => {
  const headers = { Cookie: cookie, Origin: `http://127.0.0.1:${port}`, "X-Blueprint-Request": "1", "Content-Type": "application/json" };
  const body = JSON.stringify({ items: [{ comment: "c", evil: "x", __proto__: { a: 1 }, target: { kind: "nonsense", blockId: "../../x", extra: 1 }, attachments: ["../../etc/passwd"] }] });
  assert.equal((await req({ method: "POST", route: "/api/feedback", headers, body })).status, 200);
  const polled = cli("poll", planPath, "--wait", "3");
  assert.equal(polled.status, "feedback");
  assert.match(polled.handling, /confirm with the user/);
  const item = polled.batches.at(-1).items[0];
  assert.deepEqual(Object.keys(item).sort(), ["attachments", "comment", "n", "target"]);
  assert.equal(item.target.kind, "general");
  assert.equal(item.target.blockId, undefined);
  assert.deepEqual(item.attachments, []);
});

test("unsupported methods are refused", async () => {
  for (const method of ["PUT", "DELETE", "PATCH", "OPTIONS"]) {
    assert.equal((await req({ method, route: "/api/state", headers: { Cookie: cookie } })).status, 405);
  }
});

test("schema rejects malformed plans", () => {
  assert.equal(validatePlan(plan).ok, true);
  assert.equal(validatePlan({ ...plan, blueprint: 2 }).ok, false);
  assert.equal(validatePlan({ ...plan, sections: [] }).ok, false);
  const dup = structuredClone(plan);
  dup.sections[0].blocks.push({ id: "b", type: "markdown", text: "again" });
  assert.match(validatePlan(dup).errors[0], /duplicate id/);
  const bad = structuredClone(plan);
  bad.sections[0].blocks[0] = { id: "x", type: "script", text: "x" };
  assert.equal(validatePlan(bad).ok, false);
});

test("runtime files contain no network client, shell, or eval", () => {
  for (const file of ["server/server.mjs", "server/schema.mjs", "server/paths.mjs"]) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    assert.doesNotMatch(source, /child_process|node:https|node:net"|node:dgram|node:dns|fetch\(|\beval\(|new Function|http\.request|http\.get/, file);
  }
  const cliSource = fs.readFileSync(CLI, "utf8");
  assert.doesNotMatch(cliSource, /node:http|node:https|node:net|fetch\(|\beval\(|new Function|shell:\s*true|[^.]\bexec\(|execSync/);
});
