import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { authHeaders, createServer } from "./helpers/authed-server.js";
import { SessionStore } from "../src/session-store.js";
import { run } from "../src/cli.js";

async function setup(t) {
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "mla-stop-"));
  const stateDir = path.join(tmp, "state");
  const file = path.join(tmp, "a.html");
  await fs.promises.writeFile(file, "<html><body>hi</body></html>");
  const store = new SessionStore(stateDir);
  const lines = [];
  const srv = createServer({ store, stateDir, port: 0, version: "t", presenceGraceMs: 0, errorLogFile: path.join(tmp, "e.json"), log: (l) => lines.push(l) });
  const { port, baseUrl } = await srv.listen();
  t.after(async () => {
    await srv.close();
    await fs.promises.rm(tmp, { recursive: true, force: true });
  });
  const { key } = await (await fetch(`${baseUrl}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ file }) })).json();
  return { srv, store, port, baseUrl, key, file, lines };
}

test("shutdown: a waiting poll gets reconnect, WebSockets close with 1001, queued writes finish, then closed", async (t) => {
  const { srv, store, port, baseUrl, key, file, lines } = await setup(t);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/events/${key}`, { headers: authHeaders(port) });
  await new Promise((r) => ws.once("open", r));
  const closeCode = new Promise((r) => ws.once("close", (code) => r(code)));
  const poll = fetch(`${baseUrl}/api/poll`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ file, timeoutMs: 30000 }) });
  await new Promise((r) => setTimeout(r, 200));
  // A transaction queued before the signal must finish before "closed".
  let wrote = false;
  const pending = store.transact(async (state) => {
    await new Promise((r) => setTimeout(r, 150));
    state.sessions[key].note = "kept";
    wrote = true;
    return [null, true];
  });
  const closed = new Promise((r) => srv.events.once("closed", r));
  srv.shutdown("SIGTERM");
  const body = await (await poll).json();
  assert.deepEqual(body, { status: "waiting", reconnect: true });
  assert.equal(await closeCode, 1001);
  await closed;
  assert.equal(wrote, true, "the queued write finished first");
  await pending;
  assert.equal((await store.getSession(key)).note, "kept");
  assert.ok(lines.some((l) => /shutting down \(SIGTERM\)/.test(l)));
  assert.strictEqual(srv.shutdown("again"), srv.shutdown("and again"), "a second signal reuses the same shutdown");
});

test("the event log names sessions and counts notes, never note text", async (t) => {
  const { baseUrl, key, file, lines } = await setup(t);
  const poll = fetch(`${baseUrl}/api/poll`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ file, timeoutMs: 5000 }) });
  await new Promise((r) => setTimeout(r, 150));
  await fetch(`${baseUrl}/api/${key}/prompts`, { method: "POST", headers: { "content-type": "application/json", origin: baseUrl }, body: JSON.stringify({ prompts: [{ prompt_id: "x", prompt: "SECRET NOTE TEXT", tag: "h1", selector: "h1", text: "hi" }] }) });
  await poll;
  const all = lines.join("\n");
  assert.match(all, /session opened: a\.html/);
  assert.match(all, /poll connected: a\.html/);
  assert.match(all, /feedback sent: 1 note/);
  assert.match(all, /poll returned: a\.html, 1 note/);
  assert.ok(!all.includes("SECRET NOTE TEXT"));
});

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function fakeIo(env) {
  const out = [];
  const err = [];
  return { io: { stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) }, env }, stdout: () => out.join(""), stderr: () => err.join("") };
}

test("poll: a server that resets the socket mid-poll is a routine reconnect (exit 0)", async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "mla-reset-"));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "p.html");
  await fs.promises.writeFile(file, "<html></html>");
  const server = http.createServer((req, res) => {
    if (req.url === "/health") return res.end(JSON.stringify({ ok: true, app: "my-lavish-axi", auth: "token" }));
    req.resume();
    setTimeout(() => req.socket.destroy(), 100); // the server window was closed
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => { server.close(() => r()); server.closeAllConnections?.(); }));
  const port = server.address().port;
  await fs.promises.writeFile(path.join(dir, "server.json"), JSON.stringify({ port, pid: process.pid, token: "t".repeat(43) }));
  const a = fakeIo({ MY_LAVISH_STATE_DIR: dir, MY_LAVISH_PORT: String(port), MY_LAVISH_NO_OPEN: "1" });
  assert.equal(await run(["poll", file, "--json"], a.io), 0, a.stdout());
  const out = JSON.parse(a.stdout());
  assert.deepEqual([out.session.status, out.session.reconnect], ["waiting", true]);
  assert.match(out.next_step, /Run `see-plan poll/);
});

test("a late second server exits 0 and never overwrites server.json; an old server without auth says to stop it", async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "mla-late-"));
  const port = await freePort();
  const env = { ...process.env, MY_LAVISH_STATE_DIR: dir, MY_LAVISH_PORT: String(port), MY_LAVISH_NO_OPEN: "1", MY_LAVISH_SERVER_WINDOW: "hidden", MY_LAVISH_ERROR_LOG: path.join(dir, "e.json") };
  t.after(async () => {
    await run(["stop"], fakeIo(env).io).catch(() => {});
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  });
  const file = path.join(dir, "p.html");
  await fs.promises.writeFile(file, "<html></html>");
  const o = fakeIo(env);
  assert.equal(await run(["open", file, "--json"], o.io), 0, o.stdout());
  const before = await fs.promises.readFile(path.join(dir, "server.json"), "utf8");
  const late = fakeIo(env);
  assert.equal(await run(["server"], late.io), 0);
  assert.match(late.stderr(), /Another see-plan server is already running on :\d+; this window can be closed\./);
  assert.equal(await fs.promises.readFile(path.join(dir, "server.json"), "utf8"), before);

  const status = fakeIo(env);
  status.io.stdout.isTTY = true;
  assert.equal(await run(["--json"], status.io), 0);
  assert.match(JSON.parse(status.stdout()).server_status, /^running hidden \(pid \d+\)$/);

  // T7: a 3.x server (no `auth` in /health) is reported, not silently used.
  const old = http.createServer((req, res) => res.end(JSON.stringify({ ok: true, app: "my-lavish-axi", version: "3.2.0" })));
  await new Promise((r) => old.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => { old.close(() => r()); old.closeAllConnections?.(); }));
  const o2 = fakeIo({ ...env, MY_LAVISH_PORT: String(old.address().port) });
  assert.equal(await run(["open", file, "--json"], o2.io), 1);
  const err = JSON.parse(o2.stdout());
  assert.equal(err.error.code, "SERVER_OUTDATED");
  assert.match(err.next_step, /see-plan stop/);
});
