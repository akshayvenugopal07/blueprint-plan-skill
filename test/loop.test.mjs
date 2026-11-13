// The agent loop: open -> poll -> reply, including the failure modes agents hit in practice.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(root, "bin/blueprint.mjs");
const project = fs.mkdtempSync(path.join(os.tmpdir(), "blueprint-loop-"));
const run = (...args) => {
  try {
    return JSON.parse(execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8", cwd: project, stdio: ["ignore", "pipe", "pipe"] }));
  } catch (error) {
    return { exitCode: error.status, ...JSON.parse(error.stdout) };
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let planPath;
let review;
let port;
let cookie;

function browser(method, route, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const headers = { Cookie: cookie };
    if (payload) Object.assign(headers, { "Content-Type": "application/json", Origin: `http://127.0.0.1:${port}`, "X-Blueprint-Request": "1" });
    const r = http.request({ host: "127.0.0.1", port, method, path: route, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, json: (() => { try { return JSON.parse(Buffer.concat(chunks)); } catch { return null; } })() }));
    });
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}
const sendNote = (comment) => browser("POST", "/api/feedback", { items: [{ comment, target: { kind: "general" } }] });
const edit = (mutate) => {
  const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
  mutate(plan);
  fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));
};

async function launch() {
  const opened = run("open", planPath, "--no-browser");
  assert.equal(opened.status, "open", JSON.stringify(opened));
  const url = new URL(opened.launch_url);
  port = Number(url.port);
  const res = await new Promise((resolve) => http.get({ host: "127.0.0.1", port, path: url.pathname + url.search }, resolve));
  cookie = res.headers["set-cookie"][0].split(";")[0];
  return opened;
}

before(async () => {
  const created = run("init", "checkout-redesign");
  planPath = created.plan;
  review = path.join(path.dirname(planPath), "review");
  edit((plan) => {
    plan.title = "Checkout redesign";
  });
  await launch();
});
after(() => run("end", planPath));

test("init puts plans in the project's blueprint folder, git-ignored", () => {
  assert.equal(planPath, path.join(fs.realpathSync(project), "blueprint/checkout-redesign/checkout-redesign.plan.json"));
  assert.equal(fs.readFileSync(path.join(project, "blueprint/.gitignore"), "utf8").trim().split("\n").pop(), "*");
  assert.equal(run("init", "checkout-redesign").status, "exists");
  assert.equal(run("list").plans[0].review_open, true);
});

test("guidance contains real, runnable commands", () => {
  const status = run("status", planPath);
  assert.ok(status.next_step.includes(`node ${JSON.stringify(CLI)} poll`), status.next_step);
  assert.doesNotMatch(status.next_step, /blueprint poll <plan>/);
});

test("editing the plan does not publish drafts; replying does", async () => {
  assert.equal(run("status", planPath).current_draft, 1);
  for (let i = 0; i < 3; i += 1) {
    edit((plan) => {
      plan.summary = `edit ${i}`;
    });
    await sleep(500);
  }
  fs.writeFileSync(planPath, '{"blueprint":1,'); // half-written
  await sleep(600);
  const state = await browser("GET", "/api/state");
  assert.equal(state.json.draft, 1);
  assert.equal(state.json.revising, true);
  const rejected = run("reply", planPath, "--message", "done");
  assert.equal(rejected.exitCode, 1);
  assert.equal(run("status", planPath).current_draft, 1);
});

test("a valid reply publishes exactly one new draft", async () => {
  fs.writeFileSync(
    planPath,
    JSON.stringify({ blueprint: 1, title: "Checkout redesign", summary: "edit 3", sections: [{ id: "s", title: "S", blocks: [{ id: "b", type: "markdown", text: "x" }] }] }),
  );
  const replied = run("reply", planPath, "--message", "Updated the summary.");
  assert.equal(replied.current_draft, 2);
  assert.equal(replied.published_new_draft, true);
  const again = run("reply", planPath, "--message", "No changes this time.");
  assert.equal(again.current_draft, 2);
  assert.equal(again.published_new_draft, false);
});

test("feedback reaches a waiting poll and shows Seen only once printed", async () => {
  const child = spawn(process.execPath, [CLI, "poll", planPath, "--wait", "20"], { cwd: project });
  let stdout = "";
  child.stdout.on("data", (d) => (stdout += d));
  const done = new Promise((r) => child.on("close", r));
  await sleep(700);
  assert.equal((await browser("GET", "/api/state")).json.agentListening, true);
  await sendNote("first note");
  await done;
  const result = JSON.parse(stdout);
  assert.equal(result.status, "feedback");
  assert.equal(result.batches[0].items[0].comment, "first note");
  assert.match(result.next_step, /--reply/);
  await sleep(600);
  assert.ok((await browser("GET", "/api/state")).json.batches.at(-1).seenAt);
});

test("a poll killed before printing does not lose feedback", async () => {
  await sendNote("note the harness swallowed");
  // Simulate a poll that claimed the batch and was then killed by its tool's timeout.
  const inbox = path.join(review, "inbox");
  const [name] = fs.readdirSync(inbox);
  fs.renameSync(path.join(inbox, name), path.join(review, "claimed", `999999~${name}`));
  const result = run("poll", planPath, "--wait", "3");
  assert.equal(result.status, "feedback");
  assert.equal(result.batches[0].items[0].comment, "note the harness swallowed");
});

test("a poll cut off by a 2-minute style timeout leaves nothing broken", async () => {
  const child = spawn(process.execPath, [CLI, "poll", planPath, "--wait", "30"], { cwd: project });
  await sleep(800);
  child.kill("SIGKILL");
  await sleep(200);
  await sendNote("after the kill");
  const result = run("poll", planPath, "--wait", "3");
  assert.equal(result.status, "feedback");
  assert.equal(result.batches[0].items[0].comment, "after the kill");
});

test("poll --reply publishes, replies and waits in one command", async () => {
  edit((plan) => {
    plan.summary = "edit 4";
    plan.changelog = [{ draft: 3, summary: "Applied notes." }];
  });
  const result = run("poll", planPath, "--reply", "Applied all notes.", "--wait", "2");
  assert.equal(result.status, "waiting");
  assert.equal(result.replied.current_draft, 3);
  const state = (await browser("GET", "/api/state")).json;
  assert.ok(state.batches.every((b) => b.doneAt), `every seen batch is marked Done: ${JSON.stringify(state.batches.map((b) => [b.items[0].comment, b.seenAt, b.doneAt]))}`);
  assert.equal(state.conversation.at(-1).text, "Applied all notes.");
});

test("a second concurrent poll is refused instead of racing", async () => {
  const child = spawn(process.execPath, [CLI, "poll", planPath, "--wait", "10"], { cwd: project });
  await sleep(700);
  assert.equal(run("poll", planPath, "--wait", "2").status, "already_listening");
  child.kill("SIGKILL");
});

test("reopening after the user ended starts exactly one fresh server", async () => {
  await browser("POST", "/api/end", {});
  assert.equal(run("poll", planPath, "--wait", "3").status, "ended");
  await launch();
  await sleep(300);
  const servers = execFileSync("ps", ["-eo", "args"], { encoding: "utf8" }).split("\n").filter((l) => l.includes("server.mjs") && l.includes(planPath));
  assert.equal(servers.length, 1, servers.join("\n"));
  assert.equal(run("status", planPath).status, "open");
  assert.equal(run("status", planPath).current_draft, 3, "history survives the restart");
});
