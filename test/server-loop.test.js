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
  const srv = createServer({ store: new SessionStore(stateDir), stateDir, port: 0, version: "0.1.0", ...opts });
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
