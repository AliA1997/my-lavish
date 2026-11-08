import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import {
  bearerOf, capFor, cookieNameFor, cookieValueFor, createNonceStore, createToken, parseCookies, pidAlive,
  readRuntimeFile, removeRuntimeFile, safeEqual, safeNext, writeRuntimeFile,
} from "../src/auth.js";
import { createServer, rawFetch } from "./helpers/authed-server.js";
import { SessionStore } from "../src/session-store.js";

test("tokens are 32 random bytes; safeEqual is exact and length-checked", () => {
  const a = createToken();
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a, createToken());
  assert.equal(safeEqual(a, a), true);
  assert.equal(safeEqual(a, a.slice(0, -1) + (a.endsWith("A") ? "B" : "A")), false, "same length, one char off");
  assert.equal(safeEqual(a, a + "x"), false);
  assert.equal(safeEqual(a, undefined), false);
  assert.equal(bearerOf(`Bearer ${a}`), a);
  assert.equal(bearerOf(`bearer  ${a} `), a);
  assert.equal(bearerOf("Basic xyz"), null);
  assert.equal(parseCookies("a=1; see_plan_4388=v; b=2").get("see_plan_4388"), "v");
  assert.equal(cookieNameFor(4388), "see_plan_4388");
  assert.notEqual(cookieValueFor(a), a, "the cookie is derived, not the token itself");
});

test("capFor is per token and per key, 32 hex digits", () => {
  const t1 = createToken();
  const t2 = createToken();
  assert.match(capFor(t1, "0123456789abcdef"), /^[0-9a-f]{32}$/);
  assert.notEqual(capFor(t1, "0123456789abcdef"), capFor(t1, "fedcba9876543210"));
  assert.notEqual(capFor(t1, "0123456789abcdef"), capFor(t2, "0123456789abcdef"));
});

test("a nonce works once and expires", () => {
  let now = 1000;
  const n = createNonceStore({ ttlMs: 60000, now: () => now });
  const a = n.issue();
  assert.equal(n.consume(a), true);
  assert.equal(n.consume(a), false, "single use");
  const b = n.issue();
  now += 60001;
  assert.equal(n.consume(b), false, "expired after 60 s");
  assert.equal(n.consume("nope"), false);
  assert.equal(n.consume(undefined), false);
});

test("safeNext accepts only same-origin relative paths", () => {
  assert.equal(safeNext("/session/0123456789abcdef"), "/session/0123456789abcdef");
  assert.equal(safeNext("/errors?project=abc"), "/errors?project=abc");
  assert.equal(safeNext(undefined), "/");
  for (const bad of ["https://evil.example/", "//evil.example/x", "/\\evil.example", "evil", "javascript:alert(1)", "/a\nb"]) {
    assert.equal(safeNext(bad), null, bad);
  }
});

test("the runtime file is written atomically, user-only on POSIX, and stale pids are detected", async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "mla-rt-"));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const sub = path.join(dir, "run");
  // A concurrent reader never sees a partial file: it is either missing or complete.
  const reads = [];
  const reader = setInterval(() => {
    try {
      reads.push(JSON.parse(fs.readFileSync(path.join(sub, "server.json"), "utf8")).token.length);
    } catch (e) {
      if (e.code !== "ENOENT") reads.push("partial");
    }
  }, 0);
  for (let i = 0; i < 30; i++) {
    await writeRuntimeFile(sub, { port: 4388, pid: process.pid, token: createToken(), version: "t" }, { execFileFn: (c, a, o, cb) => cb(null) });
  }
  clearInterval(reader);
  assert.ok(!reads.includes("partial"), "no partial file was ever read");
  if (process.platform !== "win32") {
    assert.equal((await fs.promises.stat(path.join(sub, "server.json"))).mode & 0o777, 0o600);
    assert.equal((await fs.promises.stat(sub)).mode & 0o777, 0o700);
  }
  const ok = await readRuntimeFile(sub, { port: 4388 });
  assert.equal(ok.ok, true);
  assert.equal((await readRuntimeFile(sub, { port: 4389 })).reason, "stale", "another port");
  await writeRuntimeFile(sub, { port: 4388, pid: 999999, token: "x".repeat(43) }, { execFileFn: (c, a, o, cb) => cb(null) });
  assert.equal((await readRuntimeFile(sub, { port: 4388, alive: () => false })).reason, "stale", "the pid is gone");
  assert.equal((await readRuntimeFile(path.join(dir, "none"))).reason, "missing");
  await fs.promises.writeFile(path.join(sub, "server.json"), "{");
  assert.equal((await readRuntimeFile(sub)).reason, "unreadable");
  assert.equal(pidAlive(process.pid), true);
  assert.equal(pidAlive(-1), false);
});

test("windows: icacls restricts the file; a failure is a warning, not an error", async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "mla-acl-"));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const calls = [];
  const ok = await writeRuntimeFile(dir, { port: 1, pid: 1, token: "t" }, { platform: "win32", execFileFn: (cmd, args, opts, cb) => { calls.push({ cmd, args }); cb(null); } });
  assert.equal(ok.warning, null);
  assert.match(calls[0].cmd, /System32[\\/]icacls\.exe$/i);
  assert.deepEqual(calls[0].args.slice(1, 4), ["/inheritance:r", "/grant:r", `${os.userInfo().username}:F`]);
  const failed = await writeRuntimeFile(dir, { port: 1, pid: 1, token: "t" }, { platform: "win32", execFileFn: (c, a, o, cb) => cb(new Error("access denied")) });
  assert.equal(failed.warning, "access denied");
  assert.ok(fs.existsSync(path.join(dir, "server.json")), "the file is still written");
});

test("removeRuntimeFile only removes its own pid's file", async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "mla-rm-"));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  await fs.promises.writeFile(path.join(dir, "server.json"), JSON.stringify({ pid: 4242 }));
  assert.equal(await removeRuntimeFile(dir, 1), false);
  assert.ok(fs.existsSync(path.join(dir, "server.json")));
  assert.equal(await removeRuntimeFile(dir, 4242), true);
  assert.ok(!fs.existsSync(path.join(dir, "server.json")));
});

// ---- the server's token check (T5) ----

async function setup(t, opts = {}) {
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "mla-auth-"));
  const stateDir = path.join(tmp, "state");
  const file = path.join(tmp, "a.html");
  await fs.promises.writeFile(file, "<html><body><h1>hi</h1></body></html>");
  const srv = createServer({ store: new SessionStore(stateDir), stateDir, port: 0, version: "t", errorLogFile: path.join(tmp, "e.json"), claudeDir: path.join(tmp, "claude"), ...opts });
  const { port, baseUrl } = await srv.listen();
  t.after(async () => {
    await srv.close();
    await fs.promises.rm(tmp, { recursive: true, force: true });
  });
  const { key } = await (await fetch(`${baseUrl}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ file }) })).json();
  return { srv, port, baseUrl, key, file, tmp };
}

function raw(port, p, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: p, method, headers }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

/** Every route the app registers, as "METHOD /path" (Express 5 router stack). */
function routesOf(app) {
  const out = [];
  for (const layer of app.router.stack) {
    if (!layer.route) continue;
    for (const m of Object.keys(layer.route.methods)) out.push(`${m.toUpperCase()} ${layer.route.path}`);
  }
  return out;
}

const EXEMPT = new Set(["GET /health", "GET /auth", "GET /artifact/:key/:cap/index.html", "GET /artifact/:key/:cap/*splat"]);

test("every route needs the token unless it is explicitly exempt (a new route must be covered)", async (t) => {
  const { srv, port, key } = await setup(t);
  const routes = routesOf(srv.app);
  assert.ok(routes.length > 40, `found ${routes.length} routes`);
  const fill = (p) => p.replace(":key", key).replace(":project", "0123456789abcdef").replace(":id", "00000000-0000-4000-8000-000000000001").replace(":n", "0").replace(":cap", "0".repeat(32)).replace("*splat", "x");
  for (const r of routes) {
    const [method, p] = r.split(" ");
    if (p.endsWith(".js") || p.endsWith(".css")) {
      assert.equal((await raw(port, p)).status, 200, `${r} (a public file) is open`);
      continue;
    }
    if (EXEMPT.has(r)) continue;
    const res = await raw(port, fill(p), { method, headers: { "content-type": "application/json", origin: `http://127.0.0.1:${port}` }, body: method === "GET" ? undefined : "{}" });
    assert.equal(res.status, 401, `${r} without credentials answered ${res.status}`);
  }
  const health = JSON.parse((await raw(port, "/health")).text);
  assert.deepEqual(Object.keys(health).sort(), ["app", "auth", "ok", "version"], "/health says nothing else (no state_dir)");
});

test("bearer and cookie both work; a wrong token of the same length is refused", async (t) => {
  const { srv, port, key } = await setup(t);
  assert.equal((await raw(port, `/api/${key}/status`, { headers: { authorization: `Bearer ${srv.token}` } })).status, 200);
  const wrong = srv.token.slice(0, -1) + (srv.token.endsWith("A") ? "B" : "A");
  const refused = await raw(port, `/api/${key}/status`, { headers: { authorization: `Bearer ${wrong}` } });
  assert.equal(refused.status, 401);
  assert.equal(JSON.parse(refused.text).error.code, "AUTH_REQUIRED");
  assert.match(JSON.parse(refused.text).error.message, /upgrade see-plan/);
  const cookie = `${cookieNameFor(port)}=${cookieValueFor(srv.token)}`;
  assert.equal((await raw(port, `/api/${key}/status`, { headers: { cookie } })).status, 200);
  assert.equal((await raw(port, `/api/${key}/status`, { headers: { cookie: `${cookieNameFor(port + 1)}=${cookieValueFor(srv.token)}` } })).status, 401, "another port's cookie name");
  const page = await raw(port, `/session/${key}`);
  assert.equal(page.status, 401);
  assert.match(page.text, /see-plan url/, "the 401 page says how to sign in");
  assert.equal((await raw(port, `/session/${key}`, { headers: { cookie } })).status, 200);
});

test("the sign-in link: a bearer-only nonce, once, then an HttpOnly SameSite=Strict cookie and a 303", async (t) => {
  const { srv, port, key } = await setup(t, { nonceTtlMs: 200 });
  const cookie = `${cookieNameFor(port)}=${cookieValueFor(srv.token)}`;
  assert.equal((await raw(port, "/api/auth/nonce", { method: "POST", headers: { cookie } })).status, 401, "a cookie cannot mint sign-in links");
  const mint = async () => JSON.parse((await raw(port, "/api/auth/nonce", { method: "POST", headers: { authorization: `Bearer ${srv.token}` } })).text).nonce;
  const nonce = await mint();
  const next = encodeURIComponent(`/session/${key}`);
  assert.equal((await raw(port, `/auth?t=${nonce}&next=${encodeURIComponent("https://evil.example/")}`)).status, 400);
  assert.equal((await raw(port, `/auth?t=${nonce}&next=${encodeURIComponent("//evil.example")}`)).status, 400);
  const ok = await raw(port, `/auth?t=${nonce}&next=${next}`);
  assert.equal(ok.status, 303);
  assert.equal(ok.headers.location, `/session/${key}`);
  const set = String(ok.headers["set-cookie"]);
  assert.match(set, new RegExp(`^${cookieNameFor(port)}=[0-9a-f]{64}; HttpOnly; SameSite=Strict; Path=/$`));
  assert.ok(!set.includes(srv.token), "the cookie is not the token");
  assert.equal((await raw(port, `/auth?t=${nonce}&next=${next}`)).status, 401, "used once");
  const late = await mint();
  await new Promise((r) => setTimeout(r, 250));
  assert.equal((await raw(port, `/auth?t=${late}&next=${next}`)).status, 401, "expired");
});

test("the WebSocket upgrade needs the cookie (or the bearer)", async (t) => {
  const { srv, port, key } = await setup(t);
  const attempt = (headers) => new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/events/${key}`, { headers });
    ws.once("open", () => {
      ws.close();
      resolve("open");
    });
    ws.once("unexpected-response", (req, res) => resolve(res.statusCode));
    ws.once("error", () => resolve("error"));
  });
  assert.equal(await attempt({}), 401);
  assert.equal(await attempt({ cookie: `${cookieNameFor(port)}=${cookieValueFor(srv.token)}` }), "open");
  assert.equal(await attempt({ authorization: `Bearer ${srv.token}` }), "open");
  assert.equal(await attempt({ cookie: `${cookieNameFor(port)}=nope` }), 401);
});

test("MY_LAVISH_ALLOWED_HOSTS: an unlisted host is 403, a listed one still needs the token; https forwarders get Secure", async (t) => {
  const { srv, port, key } = await setup(t, { allowedHosts: ["mybox-4388.app.github.dev"] });
  const host = "mybox-4388.app.github.dev";
  assert.equal((await raw(port, "/health", { headers: { host: "evil.example" } })).status, 403);
  assert.equal((await raw(port, `/api/${key}/status`, { headers: { host } })).status, 401, "listed host without credentials");
  assert.equal((await raw(port, `/api/${key}/status`, { headers: { host, authorization: `Bearer ${srv.token}` } })).status, 200);
  const nonce = JSON.parse((await raw(port, "/api/auth/nonce", { method: "POST", headers: { authorization: `Bearer ${srv.token}` } })).text).nonce;
  const signed = await raw(port, `/auth?t=${nonce}&next=%2F`, { headers: { host, "x-forwarded-proto": "https" } });
  assert.match(String(signed.headers["set-cookie"]), /; Secure$/);
  // X-Forwarded-Proto is ignored on plain loopback hosts.
  const n2 = JSON.parse((await raw(port, "/api/auth/nonce", { method: "POST", headers: { authorization: `Bearer ${srv.token}` } })).text).nonce;
  const local = await raw(port, `/auth?t=${n2}&next=%2F`, { headers: { "x-forwarded-proto": "https" } });
  assert.doesNotMatch(String(local.headers["set-cookie"]), /Secure/);
  // The forwarded page's own https origin may write.
  const write = await raw(port, `/api/${key}/agent-reply`, { method: "POST", headers: { host, origin: `https://${host}`, authorization: `Bearer ${srv.token}`, "content-type": "application/json" }, body: JSON.stringify({ text: "hi" }) });
  assert.equal(write.status, 200);
});

test("allowed hosts never widen access without the token (no option turns the token off)", async (t) => {
  const { port } = await setup(t, { allowedHosts: ["*", ""] });
  assert.equal((await raw(port, "/api/sessions", { headers: { host: "anything.example" } })).status, 403, "no wildcard");
  assert.equal((await rawFetch(`http://127.0.0.1:${port}/api/sessions`)).status, 401);
});
