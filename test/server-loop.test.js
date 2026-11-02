import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
import { createServer } from "../src/server.js";
import { SessionStore } from "../src/session-store.js";

async function setup(t, opts = {}) {
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "mla-loop-"));
  const stateDir = path.join(tmp, "state");
  const art = path.join(tmp, "art");
  await fs.promises.mkdir(art, { recursive: true });
  const file = path.join(art, "a.html");
  await fs.promises.writeFile(file, "<html><body><h1 id=t>hi</h1></body></html>");
  await fs.promises.writeFile(path.join(art, "style.css"), "h1{color:red}");
  const srv = createServer({ store: new SessionStore(stateDir), stateDir, port: 0, version: "0.1.0", presenceGraceMs: 0, ...opts });
  const { port, baseUrl } = await srv.listen();
  t.after(async () => {
    await srv.close();
    await fs.promises.rm(tmp, { recursive: true, force: true });
  });
  const opened = await fetch(baseUrl + "/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ file }),
  });
  const { key } = await opened.json();

  const postJson = (p, body, headers = {}) =>
    fetch(baseUrl + p, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  const postPrompts = (k, body) => postJson(`/api/${k}/prompts`, body, { Origin: baseUrl });
  const poll = (timeoutMs, init = {}) =>
    fetch(`${baseUrl}/api/poll?file=${encodeURIComponent(file)}&timeoutMs=${timeoutMs}`, init);
  return { srv, tmp, art, file, port, baseUrl, key, postJson, postPrompts, poll };
}

let seq = 0;
const note = (text) => ({ prompt_id: `p-${++seq}`, prompt: text, tag: "h1", selector: "#t", text: "hi" });

function connectWs(port, key) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/events/${key}`);
    const messages = [];
    const checks = new Set();
    ws.on("message", (d) => {
      messages.push(JSON.parse(String(d)));
      for (const c of [...checks]) c();
    });
    const waitFor = (pred, ms = 3000, from = 0) =>
      new Promise((res, rej) => {
        const check = () => {
          const m = messages.slice(from).find(pred);
          if (!m) return false;
          clearTimeout(timer);
          checks.delete(check);
          res(m);
          return true;
        };
        const timer = setTimeout(() => {
          checks.delete(check);
          rej(new Error(`no matching ws message; got ${JSON.stringify(messages)}`));
        }, ms);
        if (!check()) checks.add(check);
      });
    ws.once("open", () => resolve({ ws, messages, waitFor }));
    ws.once("error", reject);
  });
}

function wsAttempt(port, p, headers = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${p}`, { headers });
    ws.on("unexpected-response", (req, res) => {
      resolve(res.statusCode);
      req.destroy();
    });
    ws.on("error", (e) => resolve(e.message));
    ws.on("open", () => {
      resolve("open");
      ws.terminate();
    });
  });
}

async function bootstrap(baseUrl, key) {
  const html = await (await fetch(`${baseUrl}/session/${key}`)).text();
  const m = html.match(/<script type="application\/json" id="my-lavish-session">([\s\S]*?)<\/script>/);
  return JSON.parse(m[1]);
}

test("prompts require same origin and return the chat", async (t) => {
  const { key, postJson, postPrompts } = await setup(t);
  const bare = await postJson(`/api/${key}/prompts`, { prompts: [note("x")] });
  assert.equal(bare.status, 403);
  const r = await postPrompts(key, { prompts: [note("make it blue")] });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.accepted, 1);
  assert.equal(j.chat[0].text, "make it blue");
  assert.equal((await postPrompts("ffffffffffffffff", { prompts: [note("x")] })).status, 404);
});

test("feedback queued before poll returns at once", async (t) => {
  const { key, postPrompts, poll } = await setup(t);
  await postPrompts(key, { prompts: [note("queued")], dom_snapshot: "<h1>hi</h1>" });
  const started = Date.now();
  const j = await (await poll(2000)).json();
  assert.equal(j.status, "feedback");
  assert.equal(j.prompts[0].prompt, "queued");
  assert.equal(j.dom_snapshot, "<h1>hi</h1>");
  assert.ok(Date.now() - started < 1000);
});

test("waiting poll resolves when prompts arrive", async (t) => {
  const { key, postPrompts, poll } = await setup(t);
  const started = Date.now();
  const pending = poll(5000).then((r) => r.json());
  await delay(100);
  await postPrompts(key, { prompts: [note("live")] });
  const j = await pending;
  assert.equal(j.status, "feedback");
  assert.equal(j.prompts[0].prompt, "live");
  assert.ok(Date.now() - started < 1000, `took ${Date.now() - started} ms`);
});

test("poll times out with waiting", async (t) => {
  const { poll } = await setup(t);
  const r = await poll(200);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { status: "waiting" });
});

test("poll without timeout waits until close, and close does not hang", async (t) => {
  const { srv, baseUrl, file } = await setup(t);
  let settled = false;
  const pending = fetch(`${baseUrl}/api/poll?file=${encodeURIComponent(file)}`)
    .then((r) => r.json(), (e) => e)
    .finally(() => (settled = true));
  await delay(500);
  assert.equal(settled, false, "no timer when timeoutMs is omitted");
  const started = Date.now();
  await srv.close();
  await pending;
  assert.ok(Date.now() - started < 2000, `close took ${Date.now() - started} ms`);
});

test("GET poll refuses cross-site loads and ignores agent_reply", async (t) => {
  const { baseUrl, key, file, postPrompts, poll } = await setup(t);
  await postPrompts(key, { prompts: [note("keep me")] });
  const url = `${baseUrl}/api/poll?file=${encodeURIComponent(file)}&timeoutMs=200`;
  assert.equal((await fetch(url, { headers: { Referer: "http://evil.example/" } })).status, 403);
  assert.equal((await fetch(url, { headers: { "Sec-Fetch-Site": "cross-site" } })).status, 403);
  const j = await (await poll(200)).json();
  assert.equal(j.status, "feedback", "refused polls took nothing");
  await fetch(`${url}&agent_reply=${encodeURIComponent("injected")}`);
  const data = await bootstrap(baseUrl, key);
  assert.ok(!data.chat.some((e) => e.role === "agent"));
});

test("unknown file polls as missing", async (t) => {
  const { baseUrl, art } = await setup(t);
  const other = path.join(art, "other.html");
  await fs.promises.writeFile(other, "<p>x</p>");
  const r = await fetch(`${baseUrl}/api/poll?file=${encodeURIComponent(other)}&timeoutMs=200`);
  assert.equal(r.status, 404);
  assert.equal((await r.json()).status, "missing");
  const gone = await fetch(`${baseUrl}/api/poll?file=${encodeURIComponent(path.join(art, "nope.html"))}`);
  assert.equal(gone.status, 404);
});

test("second concurrent poll is refused", async (t) => {
  const { key, postPrompts, poll } = await setup(t);
  const first = poll(3000).then((r) => r.json());
  await delay(100);
  const second = await poll(3000);
  assert.equal(second.status, 409);
  assert.equal((await second.json()).error.code, "LISTENER_ACTIVE");
  await postPrompts(key, { prompts: [note("release")] });
  assert.equal((await first).status, "feedback");
});

test("killed poll frees the listener and loses nothing", async (t) => {
  const { srv, key, postPrompts, poll } = await setup(t);
  const ac = new AbortController();
  const killed = poll(5000, { signal: ac.signal }).catch((e) => e);
  await delay(100);
  ac.abort();
  await killed;
  // The disconnect alone (no new event) must remove the listener and free the slot.
  const deadline = Date.now() + 2000;
  while (srv.events.listenerCount("feedback") > 0 && Date.now() < deadline) await delay(20);
  assert.equal(srv.events.listenerCount("feedback"), 0, "listener removed on disconnect");
  assert.deepEqual(await (await poll(200)).json(), { status: "waiting" });
  await postPrompts(key, { prompts: [note("after kill")] });
  const r = await poll(2000);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.status, "feedback");
  assert.deepEqual(j.prompts.map((p) => p.prompt), ["after kill"]);
  assert.equal(srv.events.listenerCount("feedback"), 0);
  assert.equal(srv.events.listenerCount("ended"), 0);
});

test("feedback taken by a poll whose client vanished is restored", async (t) => {
  const { srv, key, port, file, postPrompts, poll } = await setup(t);
  const req = http.request({
    host: "127.0.0.1",
    port,
    agent: false,
    path: `/api/poll?file=${encodeURIComponent(file)}&timeoutMs=5000`,
  });
  req.on("error", () => {});
  req.end();
  await delay(150);
  // Runs before the poll's own listener: the client is gone while feedback is taken.
  srv.events.prependOnceListener("feedback", () => req.destroy());
  await postPrompts(key, { prompts: [note("not lost")] });
  const r = await poll(2000);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.status, "feedback");
  assert.deepEqual(j.prompts.map((p) => p.prompt), ["not lost"]);
});

test("poll with agent_reply adds a rendered agent chat entry", async (t) => {
  const { baseUrl, key, file, postJson } = await setup(t);
  const r = await postJson("/api/poll", { file, agent_reply: "Done **ok**", timeoutMs: 200 });
  assert.deepEqual(await r.json(), { status: "waiting" });
  const data = await bootstrap(baseUrl, key);
  const agent = data.chat.find((e) => e.role === "agent");
  assert.ok(agent, "agent entry present");
  assert.ok(agent.html.includes("<strong>ok</strong>"));
});

test("agent-reply route validates text", async (t) => {
  const { baseUrl, key, postJson } = await setup(t);
  assert.equal((await postJson(`/api/${key}/agent-reply`, { text: "   " })).status, 400);
  const ok = await postJson(`/api/${key}/agent-reply`, { text: "hello" });
  assert.deepEqual(await ok.json(), { ok: true });
  const data = await bootstrap(baseUrl, key);
  assert.equal(data.chat.at(-1).html, "<p>hello</p>");
  assert.equal((await postJson("/api/ffffffffffffffff/agent-reply", { text: "x" })).status, 404);
});

test("browser end wakes the poll; later prompts are refused", async (t) => {
  const { baseUrl, key, postJson, postPrompts, poll } = await setup(t);
  const pending = poll(5000).then((r) => r.json());
  await delay(100);
  const end = await postJson(`/api/${key}/end`, { ended_by: "agent" }, { Origin: baseUrl });
  assert.equal(end.status, 200);
  assert.deepEqual(await pending, { status: "ended", ended_by: "user" });
  const late = await postPrompts(key, { prompts: [note("too late")] });
  assert.equal(late.status, 409);
  assert.equal((await late.json()).error.code, "ENDED");
});

test("header-less end records the agent", async (t) => {
  const { key, postJson, poll } = await setup(t);
  assert.equal((await postJson(`/api/${key}/end`, {})).status, 200);
  assert.deepEqual(await (await poll(200)).json(), { status: "ended", ended_by: "agent" });
});

test("prompts with end deliver feedback then ended", async (t) => {
  const { key, postPrompts, poll } = await setup(t);
  await postPrompts(key, { prompts: [note("last word")], end: true });
  const first = await (await poll(200)).json();
  assert.equal(first.status, "feedback");
  assert.equal(first.session_ended, true);
  assert.deepEqual(await (await poll(200)).json(), { status: "ended", ended_by: "user" });
});

test("websocket gets presence, chat, and reload on file change", async (t) => {
  const { port, key, file, postPrompts, poll } = await setup(t);
  const { ws, messages, waitFor } = await connectWs(port, key);
  t.after(() => ws.terminate());
  await waitFor((m) => m.type === "presence" && m.listening === false);
  await waitFor((m) => m.type === "chat" && Array.isArray(m.chat));

  const ac = new AbortController();
  const killed = poll(5000, { signal: ac.signal }).catch((e) => e);
  await waitFor((m) => m.type === "presence" && m.listening === true);
  const mark = messages.length;
  ac.abort();
  await killed;
  await waitFor((m) => m.type === "presence" && m.listening === false, 3000, mark);

  await postPrompts(key, { prompts: [note("over ws")] });
  await waitFor((m) => m.type === "chat" && m.chat.some((e) => e.text === "over ws"));

  await fs.promises.writeFile(file, "<html><body><h1>changed</h1></body></html>");
  const reload = await waitFor((m) => m.type === "reload", 3000);
  assert.equal(reload.revision, 1);
});

test("reload fires again after the file is replaced by rename, unlink+create, or quick edits", async (t) => {
  const { port, key, file, art } = await setup(t);
  const { ws, messages, waitFor } = await connectWs(port, key);
  t.after(() => ws.terminate());
  await waitFor((m) => m.type === "chat");
  assert.equal((await waitFor((m) => m.type === "revision")).revision, 0);
  const count = () => messages.filter((m) => m.type === "reload").length;
  const expectReload = async (label, action) => {
    const before = count();
    await action();
    await waitFor((m) => m.type === "reload", 3000, messages.length > before ? 0 : messages.length)
      .catch(() => {});
    const deadline = Date.now() + 3000;
    while (count() <= before && Date.now() < deadline) await delay(50);
    assert.ok(count() > before, `no reload after: ${label}`);
    await delay(400);
  };
  await expectReload("plain write", () => fs.promises.writeFile(file, "<h1>one</h1>"));
  await expectReload("second plain write", () => fs.promises.writeFile(file, "<h1>two</h1>"));
  await expectReload("replace by rename", async () => {
    const tmpf = path.join(art, "a.html.tmp");
    await fs.promises.writeFile(tmpf, "<h1>three</h1>");
    await fs.promises.rename(tmpf, file);
  });
  await expectReload("unlink then recreate", async () => {
    await fs.promises.unlink(file);
    await delay(300);
    await fs.promises.writeFile(file, "<h1>four</h1>");
  });
  await expectReload("write after recreate", () => fs.promises.writeFile(file, "<h1>five</h1>"));
  await expectReload("quick successive edits", async () => {
    await fs.promises.writeFile(file, "<h1>six</h1>");
    await delay(30);
    await fs.promises.writeFile(file, "<h1>seven</h1>");
  });
});

test("git checkout restoring a freshly watched file always reloads (stress)", async (t) => {
  const run = promisify(execFile);
  try {
    await run("git", ["--version"]);
  } catch {
    t.skip("git is not on PATH");
    return;
  }
  const { tmp, port, baseUrl } = await setup(t);
  const repo = path.join(tmp, "repo");
  const TRIALS = 12;
  const original = "<!doctype html>\n<html><body>\n<h1>Plan</h1>\n<p>Body text.</p>\n</body></html>\n";
  // One file per trial: the miss happened on the first replace a new watcher sees.
  for (let n = 1; n <= TRIALS; n++) {
    await fs.promises.mkdir(path.join(repo, `d${n}`), { recursive: true });
    await fs.promises.writeFile(path.join(repo, `d${n}`, "plan.html"), original);
  }
  const git = (...args) => run("git", args, { cwd: repo });
  await git("init", "-q");
  await git("add", ".");
  await git("-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false",
    "commit", "-q", "--no-verify", "-m", "init");

  const misses = [];
  for (let n = 1; n <= TRIALS; n++) {
    const file = path.join(repo, `d${n}`, "plan.html");
    const opened = await fetch(baseUrl + "/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file }),
    });
    const { key } = await opened.json();
    const { ws, messages } = await connectWs(port, key);
    const reloads = () => messages.filter((m) => m.type === "reload").length;
    const waitReload = async (before) => {
      const deadline = Date.now() + 3000;
      while (reloads() <= before && Date.now() < deadline) await delay(20);
      return reloads() > before;
    };
    const gap = [0, 50, 300][n % 3];
    let before = reloads();
    await fs.promises.writeFile(file, original.replace("<h1>Plan</h1>", `<h1>EDITED Plan ${n}</h1>`));
    if (!(await waitReload(before))) misses.push(`trial ${n}: edit`);
    await delay(gap);
    before = reloads();
    await git("checkout", "--", `d${n}/plan.html`);
    if (!(await waitReload(before))) misses.push(`trial ${n}: checkout`);
    ws.terminate();
  }
  assert.deepEqual(misses, []);
});

test("rewriting identical content does not reload", async (t) => {
  const { port, key, file } = await setup(t);
  const { ws, messages, waitFor } = await connectWs(port, key);
  t.after(() => ws.terminate());
  await waitFor((m) => m.type === "revision");
  await fs.promises.writeFile(file, "<h1>new</h1>");
  assert.equal((await waitFor((m) => m.type === "reload")).revision, 1);
  await fs.promises.writeFile(file, "<h1>new</h1>");
  await delay(1200); // past chokidar's settle time and two poll ticks
  assert.equal(messages.filter((m) => m.type === "reload").length, 1);
});

test("websocket upgrade is guarded", async (t) => {
  const { port, key } = await setup(t);
  assert.equal(await wsAttempt(port, `/events/${key}`, { Host: "evil.example" }), 403);
  assert.equal(await wsAttempt(port, `/events/${key}`, { Origin: "http://evil.example" }), 403);
  assert.equal(await wsAttempt(port, "/events/ffffffffffffffff"), 404);
  assert.equal(await wsAttempt(port, `/events/${key}`, { Origin: `http://127.0.0.1:${port}` }), "open");
});

test("artifact assets are served with no-cache", async (t) => {
  const { baseUrl, key } = await setup(t);
  const r = await fetch(`${baseUrl}/artifact/${key}/style.css`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("cache-control"), "no-cache");
});

test("idle server closes itself; a connected websocket keeps it alive", async (t) => {
  const { srv, port, key } = await setup(t, { idleTimeoutMs: 1000 });
  let isClosed = false;
  const closed = new Promise((resolve) => srv.events.once("closed", resolve)).then(() => (isClosed = true));
  const { ws } = await connectWs(port, key);
  await delay(1300);
  assert.equal(isClosed, false, "stays up while a websocket is connected");
  ws.close();
  const started = Date.now();
  await Promise.race([
    closed,
    delay(4000, null, { ref: false }).then(() => assert.fail("did not close when idle")),
  ]);
  assert.ok(Date.now() - started >= 900, "countdown restarts when the last client leaves");
});

test("second end keeps the first ended_by", async (t) => {
  const { baseUrl, key, postJson, poll } = await setup(t);
  assert.equal((await postJson(`/api/${key}/end`, {}, { Origin: baseUrl })).status, 200);
  const again = await postJson(`/api/${key}/end`, {});
  assert.equal(again.status, 200);
  assert.deepEqual(await again.json(), { ok: true, ended_by: "user" });
  assert.deepEqual(await (await poll(200)).json(), { status: "ended", ended_by: "user" });
});

test("oversized timeoutMs is clamped, not collapsed to 1 ms", async (t) => {
  const { poll } = await setup(t);
  const ac = new AbortController();
  let settled = false;
  const p = poll(3000000000, { signal: ac.signal }).then(() => (settled = true), () => {});
  await delay(400);
  assert.equal(settled, false, "poll still waiting");
  ac.abort();
  await p;
});

test("restarted server re-watches existing sessions on websocket connect", async (t) => {
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "mla-restart-"));
  const stateDir = path.join(tmp, "state");
  const file = path.join(tmp, "a.html");
  await fs.promises.writeFile(file, "<html><body>hi</body></html>");
  t.after(() => fs.promises.rm(tmp, { recursive: true, force: true }));
  const mk = () => createServer({ store: new SessionStore(stateDir), stateDir, port: 0, version: "0.1.0" });
  const first = mk();
  const a = await first.listen();
  const { key } = await (await fetch(a.baseUrl + "/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ file }),
  })).json();
  await first.close();
  const second = mk();
  const b = await second.listen();
  t.after(() => second.close());
  const { ws, waitFor } = await connectWs(b.port, key);
  t.after(() => ws.terminate());
  await waitFor((m) => m.type === "chat");
  await delay(300);
  await fs.promises.writeFile(file, "<html><body>changed</body></html>");
  await waitFor((m) => m.type === "reload", 3000);
});

test("new-session requires same origin", async (t) => {
  const { key, postJson } = await setup(t);
  const res = await postJson(`/api/${key}/new-session`, {});
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error.code, "FORBIDDEN_ORIGIN");
});

test("new-session restarts an ended session", async (t) => {
  const { key, port, baseUrl, postJson } = await setup(t);
  await postJson(`/api/${key}/end`, {}, { Origin: baseUrl });
  const { ws, waitFor } = await connectWs(port, key);
  t.after(() => ws.terminate());
  const res = await postJson(`/api/${key}/new-session`, {}, { Origin: baseUrl });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, "open");
  await waitFor((m) => m.type === "new-session");
  const page = await (await fetch(`${baseUrl}/session/${key}`)).text();
  assert.ok(!page.includes('"status":"ended"'));
  const again = await postJson(`/api/${key}/new-session`, {}, { Origin: baseUrl });
  assert.equal(again.status, 409);
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fakeLauncher() {
  const calls = [];
  return { calls, launchClaude: async (args) => { calls.push(args); } };
}

test("connect-claude launches and records the id", async (t) => {
  const fake = fakeLauncher();
  const { key, port, baseUrl, postJson, file, art } = await setup(t, { launchClaude: fake.launchClaude });
  const { ws, waitFor } = await connectWs(port, key);
  t.after(() => ws.terminate());
  const res = await postJson(`/api/${key}/connect-claude`, {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.match(body.claude_session_id, UUID);
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].file, await fs.promises.realpath(file));
  assert.equal(fake.calls[0].sessionId, body.claude_session_id);
  assert.equal(path.resolve(fake.calls[0].cwd).startsWith(path.resolve(art).slice(0, 3)), true);
  const msg = await waitFor((m) => m.type === "claude-session");
  assert.equal(msg.id, body.claude_session_id);
  const page = await (await fetch(`${baseUrl}/session/${key}`)).text();
  assert.ok(page.includes(body.claude_session_id));
});

test("connect-claude names the md for markdown sessions", async (t) => {
  const fake = fakeLauncher();
  const { art, baseUrl, postJson } = await setup(t, { launchClaude: fake.launchClaude });
  const md = path.join(art, "plan.md");
  const html = path.join(art, "plan.html");
  await fs.promises.writeFile(md, "# Plan");
  await fs.promises.writeFile(html, "<html><body>plan</body></html>");
  const opened = await postJson("/api/sessions", { file: html, source_file: md });
  const { key } = await opened.json();
  const res = await postJson(`/api/${key}/connect-claude`, {}, { Origin: baseUrl });
  assert.equal(res.status, 200);
  assert.equal(fake.calls[0].file, await fs.promises.realpath(md));
});

test("second connect within 60s is refused for the same session only", async (t) => {
  const fake = fakeLauncher();
  const { art, key, postJson } = await setup(t, { launchClaude: fake.launchClaude });
  const other = path.join(art, "b.html");
  await fs.promises.writeFile(other, "<html></html>");
  const otherKey = (await (await postJson("/api/sessions", { file: other })).json()).key;
  const [first, same] = await Promise.all([
    postJson(`/api/${key}/connect-claude`, {}),
    postJson(`/api/${key}/connect-claude`, {}),
  ]);
  assert.deepEqual([first.status, same.status].sort(), [200, 409]);
  const diff = await postJson(`/api/${otherKey}/connect-claude`, {});
  assert.equal(diff.status, 200, "launch cooldown is per session");
  assert.equal(fake.calls.length, 2);
});

test("connect-claude refuses while a poll listens", async (t) => {
  const fake = fakeLauncher();
  const { key, poll, postJson, port } = await setup(t, { launchClaude: fake.launchClaude });
  const { ws, waitFor } = await connectWs(port, key);
  t.after(() => ws.terminate());
  const pending = poll(0).catch(() => {});
  await waitFor((m) => m.type === "presence" && m.listening === true);
  const res = await postJson(`/api/${key}/connect-claude`, {});
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error.code, "LISTENER_ACTIVE");
  assert.equal(fake.calls.length, 0);
  ws.terminate();
  void pending;
});

test("connect-claude needs json", async (t) => {
  const fake = fakeLauncher();
  const { key, baseUrl } = await setup(t, { launchClaude: fake.launchClaude });
  const res = await fetch(`${baseUrl}/api/${key}/connect-claude`, { method: "POST", headers: { "content-type": "text/plain" }, body: "x" });
  assert.equal(res.status, 415);
  assert.equal(fake.calls.length, 0);
});

test("connect-claude maps launcher failures", async (t) => {
  const { key, postJson } = await setup(t, {
    launchClaude: async () => { throw Object.assign(new Error("nope"), { code: "CLAUDE_NOT_FOUND" }); },
  });
  const res = await postJson(`/api/${key}/connect-claude`, {});
  assert.equal(res.status, 424);
  assert.equal((await res.json()).error.code, "CLAUDE_NOT_FOUND");
  const again = await postJson(`/api/${key}/connect-claude`, {});
  assert.equal(again.status, 424, "a failed launch does not block a retry");
});

const CLAUDE_ID = "1b4e28ba-2fa1-11d2-883f-0016d3cca427";

async function claudeFixture(t) {
  const claudeDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "mla-srv-claude-"));
  t.after(() => fs.promises.rm(claudeDir, { recursive: true, force: true }));
  const dir = path.join(claudeDir, "projects", "C--x");
  await fs.promises.mkdir(dir, { recursive: true });
  const transcript = path.join(dir, `${CLAUDE_ID}.jsonl`);
  const row = (text) => JSON.stringify({ type: "user", message: { content: text }, timestamp: "t" }) + "\n";
  await fs.promises.writeFile(transcript, row("one") + row("two"));
  return { claudeDir, transcript, row };
}

test("claude-log returns entries after attaching", async (t) => {
  const { claudeDir } = await claudeFixture(t);
  const { key, baseUrl, postJson } = await setup(t, { claudeDir });
  const none = await (await fetch(`${baseUrl}/api/${key}/claude-log`)).json();
  assert.deepEqual([none.claude_session_id, none.found, none.entries], [null, false, []]);
  const attach = await postJson(`/api/${key}/claude-session`, { id: CLAUDE_ID });
  assert.equal(attach.status, 200);
  const log = await (await fetch(`${baseUrl}/api/${key}/claude-log`)).json();
  assert.equal(log.found, true);
  assert.equal(log.entries.length, 2);
  const again = await (await fetch(`${baseUrl}/api/${key}/claude-log?after=${log.next}`)).json();
  assert.deepEqual(again.entries, []);
});

test("claude-log does not re-read state.json", async (t) => {
  const { claudeDir } = await claudeFixture(t);
  const { srv, key, baseUrl, postJson, tmp } = await setup(t, { claudeDir });
  await postJson(`/api/${key}/claude-session`, { id: CLAUDE_ID });
  // Spy on a second server's store would not observe this one, so count reads of state.json instead.
  const stateFile = path.join(tmp, "state", "state.json");
  const originalReadFile = fs.promises.readFile;
  let stateReads = 0;
  fs.promises.readFile = (p, ...rest) => {
    if (String(p) === stateFile) stateReads++;
    return originalReadFile(p, ...rest);
  };
  try {
    for (let i = 0; i < 4; i++) await (await fetch(`${baseUrl}/api/${key}/claude-log`)).json();
  } finally {
    fs.promises.readFile = originalReadFile;
  }
  assert.equal(stateReads, 0);
  void srv;
});

test("claude-log fills its map from the store once", async (t) => {
  const { claudeDir } = await claudeFixture(t);
  const { key, baseUrl, tmp } = await setup(t, { claudeDir });
  // Write the id straight into the store, as a previous server run would have.
  const store = new SessionStore(path.join(tmp, "state"));
  await store.setClaudeSession(key, CLAUDE_ID);
  const stateFile = path.join(tmp, "state", "state.json");
  const originalReadFile = fs.promises.readFile;
  let stateReads = 0;
  fs.promises.readFile = (p, ...rest) => {
    if (String(p) === stateFile) stateReads++;
    return originalReadFile(p, ...rest);
  };
  try {
    const first = await (await fetch(`${baseUrl}/api/${key}/claude-log`)).json();
    assert.equal(first.found, true);
    for (let i = 0; i < 3; i++) await (await fetch(`${baseUrl}/api/${key}/claude-log`)).json();
  } finally {
    fs.promises.readFile = originalReadFile;
  }
  assert.equal(stateReads, 1);
});

test("claude-log clamps after", async (t) => {
  const { claudeDir } = await claudeFixture(t);
  const { key, baseUrl, postJson } = await setup(t, { claudeDir });
  await postJson(`/api/${key}/claude-session`, { id: CLAUDE_ID });
  const base = await (await fetch(`${baseUrl}/api/${key}/claude-log?after=0`)).json();
  for (const after of ["-5", "abc"]) {
    const r = await (await fetch(`${baseUrl}/api/${key}/claude-log?after=${after}`)).json();
    assert.deepEqual(r, base);
  }
});

test("claude-session rejects a non-uuid", async (t) => {
  const { key, postJson } = await setup(t);
  const res = await postJson(`/api/${key}/claude-session`, { id: "../../etc/passwd" });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, "VALIDATION_ERROR");
});

test("claude-sessions lists recent transcripts and refuses cross-site loads", async (t) => {
  const { claudeDir } = await claudeFixture(t);
  const { baseUrl } = await setup(t, { claudeDir });
  const body = await (await fetch(`${baseUrl}/api/claude-sessions`)).json();
  assert.deepEqual(body.sessions.map((s) => [s.id, s.project, s.title]), [[CLAUDE_ID, "C--x", "one"]]);
  const cross = await fetch(`${baseUrl}/api/claude-sessions`, { headers: { "Sec-Fetch-Site": "cross-site" } });
  assert.equal(cross.status, 403);
});

test("presence names a Claude agent and shows it working after it takes feedback", async (t) => {
  const { key, file, port, postJson, postPrompts } = await setup(t);
  const { ws, waitFor, messages } = await connectWs(port, key);
  t.after(() => ws.terminate());
  assert.deepEqual(await waitFor((m) => m.type === "presence"), {
    type: "presence", listening: false, agent: null, session_id: null, working: false, cycling: false, last_poll_at: null,
  });
  const pending = postJson("/api/poll", { file, agent: "claude", claude_session_id: CLAUDE_ID });
  const listening = await waitFor((m) => m.type === "presence" && m.listening === true);
  assert.deepEqual([listening.agent, listening.session_id, listening.working], ["claude", CLAUDE_ID, false]);
  let from = messages.length;
  await postPrompts(key, { prompts: [note("go")] });
  assert.equal((await (await pending).json()).status, "feedback");
  const working = await waitFor((m) => m.type === "presence", 3000, from);
  assert.deepEqual([working.listening, working.working, working.agent], [false, true, "claude"]);

  from = messages.length;
  const next = postJson("/api/poll", { file, timeoutMs: 100 });
  const back = await waitFor((m) => m.type === "presence" && m.listening === true, 3000, from);
  assert.deepEqual([back.agent, back.working], [null, false], "a new listener replaces the working state");
  assert.equal((await (await next).json()).status, "waiting");
});

test("feedback taken without listening still reports the agent working", async (t) => {
  const { key, file, port, postJson, postPrompts } = await setup(t);
  await postPrompts(key, { prompts: [note("queued")] });
  const { ws, waitFor, messages } = await connectWs(port, key);
  t.after(() => ws.terminate());
  await waitFor((m) => m.type === "presence");
  const from = messages.length;
  assert.equal((await (await postJson("/api/poll", { file, agent: "claude" })).json()).status, "feedback");
  const working = await waitFor((m) => m.type === "presence", 3000, from);
  assert.deepEqual([working.working, working.agent], [true, "claude"]);
});

test("poll attaches the agent's own Claude session only when none is set", async (t) => {
  const { key, file, baseUrl, postJson } = await setup(t);
  const poll = (id) => postJson("/api/poll", { file, timeoutMs: 50, agent: "claude", claude_session_id: id });
  assert.equal((await poll(CLAUDE_ID)).status, 200);
  assert.equal((await bootstrap(baseUrl, key)).claude_session_id, CLAUDE_ID);
  const picked = "2b4e28ba-2fa1-11d2-883f-0016d3cca427";
  assert.equal((await postJson(`/api/${key}/claude-session`, { id: picked })).status, 200);
  assert.equal((await poll(CLAUDE_ID)).status, 200);
  assert.equal((await bootstrap(baseUrl, key)).claude_session_id, picked, "the user's pick is kept");
});

test("poll rejects a malformed claude_session_id", async (t) => {
  const { file, postJson } = await setup(t);
  const res = await postJson("/api/poll", { file, claude_session_id: "../x" });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, "VALIDATION_ERROR");
});

test("a claude-log entry reaches the poll without wiping the page snapshot", async (t) => {
  const { key, postPrompts, poll } = await setup(t);
  await postPrompts(key, { prompts: [note("blue")], dom_snapshot: "<h1>hi</h1>" });
  const entry = {
    prompt_id: "claude-log:u-1:0",
    prompt: "Add this Claude log entry to ~/claude-errors/error-log.json.",
    tag: "claude-log",
    selector: "",
    text: "",
    target: {
      error_log: "~/claude-errors/error-log.json",
      entry: { claude_session_id: CLAUDE_ID, uuid: "u-1", role: "user", kind: "tool_result", at: "t", text: "boom" },
    },
  };
  const sent = await (await postPrompts(key, { prompts: [entry], dom_snapshot: "" })).json();
  assert.equal(sent.chat.at(-1).anchor, "Claude log entry");
  assert.equal(sent.chat.at(-1).prompt_id, "claude-log:u-1:0");
  const j = await (await poll(2000)).json();
  assert.equal(j.dom_snapshot, "<h1>hi</h1>");
  assert.equal(j.prompts.at(-1).target.entry.text, "boom");
  assert.equal((await (await postPrompts(key, { prompts: [entry] })).json()).accepted, 0, "a resend of the same entry is dropped");
});

test("ending a session clears the working state", async (t) => {
  const { key, file, port, baseUrl, postJson, postPrompts } = await setup(t);
  await postPrompts(key, { prompts: [note("queued")] });
  assert.equal((await (await postJson("/api/poll", { file, agent: "claude" })).json()).status, "feedback");
  assert.equal((await postJson(`/api/${key}/end`, {}, { Origin: baseUrl })).status, 200);
  assert.equal((await postJson("/api/sessions", { file, reopen: true })).status, 200);
  const { ws, waitFor } = await connectWs(port, key);
  t.after(() => ws.terminate());
  const p = await waitFor((m) => m.type === "presence");
  assert.deepEqual([p.working, p.agent], [false, null]);
});

async function logPage(t) {
  const { claudeDir, transcript } = await claudeFixture(t);
  const errorDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "mla-errlog-"));
  t.after(() => fs.promises.rm(errorDir, { recursive: true, force: true }));
  const errorLogFile = path.join(errorDir, "claude-errors", "error-log.json");
  const ctx = await setup(t, { claudeDir, errorLogFile });
  const entry = { claude_session_id: CLAUDE_ID, uuid: "u-9", part: 0, role: "user", kind: "text", at: "2026-10-25T23:32:00.000Z", text: "three" };
  return { ...ctx, transcript, errorLogFile, entry };
}

test("the Claude log page reads a session by id, with its last prompt time", async (t) => {
  const { baseUrl, transcript } = await logPage(t);
  const line = (o) => JSON.stringify(o) + "\n";
  await fs.promises.appendFile(transcript,
    line({ type: "user", uuid: "u-9", timestamp: "2026-10-25T23:32:00.000Z", message: { content: "three" } }) +
    line({ type: "assistant", uuid: "a-1", timestamp: "2026-10-25T23:33:00.000Z", message: { content: [{ type: "text", text: "ok" }] } }));
  const page = await fetch(`${baseUrl}/claude`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("x-frame-options"), "DENY");
  assert.match(await page.text(), /id="sessionId"/);

  const log = await (await fetch(`${baseUrl}/api/claude-sessions/${CLAUDE_ID}/log`)).json();
  assert.equal(log.found, true);
  assert.deepEqual(log.entries.map((e) => e.text), ["one", "two", "three", "ok"]);
  assert.equal(log.last_prompt_at, "2026-10-25T23:32:00.000Z");
  assert.deepEqual(log.reported, []);
  const later = await (await fetch(`${baseUrl}/api/claude-sessions/${CLAUDE_ID}/log?after=${log.next}`)).json();
  assert.deepEqual([later.entries, later.reported], [[], undefined]);

  const unknown = await (await fetch(`${baseUrl}/api/claude-sessions/00000000-0000-4000-8000-000000000000/log`)).json();
  assert.equal(unknown.found, false);
  assert.equal((await fetch(`${baseUrl}/api/claude-sessions/not-a-uuid/log`)).status, 400);
  const cross = await fetch(`${baseUrl}/api/claude-sessions/${CLAUDE_ID}/log`, { headers: { "Sec-Fetch-Site": "cross-site" } });
  assert.equal(cross.status, 403);
});

test("a log page click appends the entry to the error log once", async (t) => {
  const { baseUrl, postJson, errorLogFile, entry } = await logPage(t);
  const page = { Origin: baseUrl };
  assert.equal((await postJson("/api/claude-errors", { entry })).status, 403, "only the page may write");
  const first = await postJson("/api/claude-errors", { entry }, page);
  assert.equal(first.status, 200);
  assert.equal((await first.json()).duplicate, false);
  assert.equal((await (await postJson("/api/claude-errors", { entry }, page)).json()).duplicate, true);
  await postJson("/api/claude-errors", { entry: { ...entry, part: 1, role: "assistant", kind: "tool_use" } }, page);

  const records = JSON.parse(await fs.promises.readFile(errorLogFile, "utf8"));
  assert.deepEqual(records.map((r) => [r.claude_session_id, r.uuid, r.part, r.text]), [[CLAUDE_ID, "u-9", 0, "three"], [CLAUDE_ID, "u-9", 1, "three"]]);
  assert.ok(!Number.isNaN(Date.parse(records[0].reported_at)));
  const log = await (await fetch(`${baseUrl}/api/claude-sessions/${CLAUDE_ID}/log`)).json();
  assert.deepEqual(log.reported, ["u-9:0", "u-9:1"]);

  for (const bad of [{ ...entry, claude_session_id: "x" }, { ...entry, role: "system" }, { ...entry, part: -1 }, { ...entry, uuid: "" }, { ...entry, text: "x".repeat(20001) }]) {
    assert.equal((await postJson("/api/claude-errors", { entry: bad }, page)).status, 400);
  }
});

test("the error log keeps existing records and is never overwritten when it is not a JSON array", async (t) => {
  const { baseUrl, postJson, errorLogFile, entry } = await logPage(t);
  await fs.promises.mkdir(path.dirname(errorLogFile), { recursive: true });
  await fs.promises.writeFile(errorLogFile, JSON.stringify([{ note: "kept" }]));
  assert.equal((await postJson("/api/claude-errors", { entry }, { Origin: baseUrl })).status, 200);
  assert.deepEqual(JSON.parse(await fs.promises.readFile(errorLogFile, "utf8")).map((r) => r.note ?? r.uuid), ["kept", "u-9"]);

  await fs.promises.writeFile(errorLogFile, "{ not json");
  const res = await postJson("/api/claude-errors", { entry: { ...entry, uuid: "u-10" } }, { Origin: baseUrl });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error.code, "ERROR_LOG_UNREADABLE");
  assert.equal(await fs.promises.readFile(errorLogFile, "utf8"), "{ not json");
});


test("agent polls are capped at agentPollMs; non-agent polls are not", async (t) => {
  const { file, postJson } = await setup(t, { agentPollMs: 150 });
  const started = Date.now();
  const j = await (await postJson("/api/poll", { file, agent: "claude" })).json();
  assert.deepEqual(j, { status: "waiting", reconnect: true });
  assert.ok(Date.now() - started < 2000);
  const big = await (await postJson("/api/poll", { file, agent: "claude", timeoutMs: 60000 })).json();
  assert.equal(big.reconnect, true);
  const ac = new AbortController();
  const human = postJson("/api/poll", { file }, {}).catch(() => "aborted");
  const raced = await Promise.race([human.then(() => "returned"), delay(500).then(() => "still waiting")]);
  assert.equal(raced, "still waiting");
  void ac;
});

test("a reconnect cycle is invisible to the user", async (t) => {
  const { key, file, port, postJson } = await setup(t, { agentPollMs: 100, presenceGraceMs: 2000 });
  const first = postJson("/api/poll", { file, agent: "claude" });
  const { ws, messages, waitFor } = await connectWs(port, key);
  t.after(() => ws.terminate());
  await waitFor((m) => m.type === "presence" && m.listening === true);
  await first;
  for (let i = 0; i < 2; i++) await (await postJson("/api/poll", { file, agent: "claude" })).json();
  await delay(100);
  const all = messages.filter((m) => m.type === "presence");
  const presences = all.slice(all.findIndex((m) => m.listening === true));
  assert.ok(presences.length >= 1);
  assert.ok(presences.every((m) => m.listening === true), JSON.stringify(presences));
});

test("after the grace period presence says not listening", async (t) => {
  const { key, file, port, postJson } = await setup(t, { agentPollMs: 50, presenceGraceMs: 200 });
  const { ws, messages, waitFor } = await connectWs(port, key);
  t.after(() => ws.terminate());
  await waitFor((m) => m.type === "presence");
  const from = messages.length;
  await (await postJson("/api/poll", { file, agent: "claude" })).json();
  const off = await waitFor((m) => m.type === "presence" && m.listening === false, 3000, from);
  assert.ok(off.last_poll_at);
});

test("a note sent during the gap reaches the next poll; connect is refused while reconnecting", async (t) => {
  const fake = fakeLauncher();
  const { key, file, postJson, postPrompts } = await setup(t, { agentPollMs: 50, presenceGraceMs: 5000, launchClaude: fake.launchClaude });
  await (await postJson("/api/poll", { file, agent: "claude" })).json();
  const sent = await (await postPrompts(key, { prompts: [note("in the gap")] })).json();
  assert.equal(sent.delivered, "queued-for-agent");
  const connect = await postJson(`/api/${key}/connect-claude`, {});
  assert.equal(connect.status, 409);
  assert.equal((await connect.json()).error.code, "AGENT_RECONNECTING");
  assert.equal(fake.calls.length, 0);
  const j = await (await postJson("/api/poll", { file, agent: "claude" })).json();
  assert.equal(j.status, "feedback");
  assert.equal(j.prompts[0].prompt, "in the gap");
});

test("notes sent with no agent around are only queued", async (t) => {
  const { key, postPrompts } = await setup(t);
  assert.equal((await (await postPrompts(key, { prompts: [note("x")] })).json()).delivered, "queued");
});

test("claude-status reports how Connect Claude would launch", async (t) => {
  let calls = 0;
  const status = { platform: "linux", launch: "copy", claude_found: true, claude_path: "/usr/bin/claude" };
  const { baseUrl } = await setup(t, { claudeStatus: async () => { calls++; return status; } });
  assert.deepEqual(await (await fetch(`${baseUrl}/api/claude-status`)).json(), status);
  await fetch(`${baseUrl}/api/claude-status`);
  assert.equal(calls, 1, "cached per process");
  assert.equal((await fetch(`${baseUrl}/api/claude-status`, { headers: { "Sec-Fetch-Site": "cross-site" } })).status, 403);
});

test("connect-claude returns copy mode and the launch prompt carries the label", async (t) => {
  const calls = [];
  const { key, postJson, baseUrl } = await setup(t, {
    launchClaude: async (args) => { calls.push(args); return { mode: "copy", command: "cd x && claude" }; },
  });
  const body = await (await postJson(`/api/${key}/connect-claude`, {})).json();
  assert.deepEqual([body.mode, body.command], ["copy", "cd x && claude"]);
  assert.ok(calls[0].prompt.startsWith("[see-plan · a · Review]"));
  assert.match(calls[0].prompt, /1:50/);
  assert.equal((await postJson(`/api/${key}/connect-claude`, {})).status, 409, "cooldown");
  assert.equal((await postJson(`/api/${key}/connect-cancel`, {})).status, 403, "cancel needs the page origin");
  assert.equal((await postJson(`/api/${key}/connect-cancel`, {}, { Origin: baseUrl })).status, 200);
  assert.equal((await postJson(`/api/${key}/connect-claude`, {})).status, 200, "cancel clears the cooldown");
});

test("connect-claude resume reuses a session that has a transcript", async (t) => {
  const { claudeDir } = await claudeFixture(t);
  const fake = fakeLauncher();
  const { key, postJson, baseUrl } = await setup(t, { claudeDir, launchClaude: fake.launchClaude });
  const none = await postJson(`/api/${key}/connect-claude`, { resume: true });
  assert.equal(none.status, 409);
  assert.equal((await none.json()).error.code, "NOTHING_TO_RESUME");
  await postJson(`/api/${key}/claude-session`, { id: CLAUDE_ID });
  assert.ok((await bootstrap(baseUrl, key)).can_resume);
  const res = await postJson(`/api/${key}/connect-claude`, { resume: true });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).claude_session_id, CLAUDE_ID);
  assert.deepEqual([fake.calls[0].resume, fake.calls[0].sessionId], [true, CLAUDE_ID]);
});
