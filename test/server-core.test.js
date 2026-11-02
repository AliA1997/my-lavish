import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createServer } from "../src/server.js";
import { SessionStore } from "../src/session-store.js";
import { injectSdk } from "../src/html-transform.js";

async function setup(t) {
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "mla-srv-"));
  const stateDir = path.join(tmp, "state");
  const art = path.join(tmp, "art");
  await fs.promises.mkdir(path.join(art, "img"), { recursive: true });
  await fs.promises.writeFile(path.join(tmp, "secret.txt"), "SECRET");
  const html = "<html><head><title>My Plan</title></head><body><h1>hi</h1></body></html>";
  await fs.promises.writeFile(path.join(art, "a.html"), html);
  await fs.promises.writeFile(path.join(art, "notes.txt"), "x");
  await fs.promises.writeFile(path.join(art, "img", "x.png"), "PNG");
  const srv = createServer({ store: new SessionStore(stateDir), stateDir, port: 0, version: "0.1.0" });
  const { port, baseUrl } = await srv.listen();
  t.after(async () => {
    await srv.close();
    await fs.promises.rm(tmp, { recursive: true, force: true });
  });
  return { tmp, art, html, port, baseUrl };
}

const post = (base, body, headers = {}) =>
  fetch(base + "/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

function rawGet(port, p, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: p, headers }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("health reports app name", async (t) => {
  const { baseUrl } = await setup(t);
  const j = await (await fetch(baseUrl + "/health")).json();
  assert.equal(j.app, "my-lavish-axi");
  assert.equal(j.version, "0.1.0");
});

test("foreign Host header is rejected", async (t) => {
  const { port } = await setup(t);
  const r = await rawGet(port, "/health", { Host: "evil.example" });
  assert.equal(r.status, 403);
  assert.equal(JSON.parse(r.body).error.code, "FORBIDDEN_HOST");
});

test("POST /api/sessions validates and opens", async (t) => {
  const { baseUrl, art } = await setup(t);
  const bad = await post(baseUrl, { file: path.join(art, "notes.txt") });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error.code, "VALIDATION_ERROR");
  const ok = await post(baseUrl, { file: path.join(art, "a.html") });
  assert.equal(ok.status, 200);
  const j = await ok.json();
  assert.equal(j.status, "opened");
  assert.match(j.key, /^[0-9a-f]{16}$/);
  assert.equal(j.url, `${baseUrl}/session/${j.key}`);
});

test("same file spelled differently maps to one key", async (t) => {
  const { baseUrl, art } = await setup(t);
  const plain = path.join(art, "a.html");
  const k1 = (await (await post(baseUrl, { file: plain })).json()).key;
  const dotted = path.join(art, "img", "..", "a.html");
  const k2 = (await (await post(baseUrl, { file: dotted })).json()).key;
  assert.equal(k2, k1);
  if (process.platform === "win32") {
    const k3 = (await (await post(baseUrl, { file: plain.toUpperCase() })).json()).key;
    assert.equal(k3, k1);
  }
});

test("chrome page is framed safely", async (t) => {
  const { baseUrl, art } = await setup(t);
  const { key } = await (await post(baseUrl, { file: path.join(art, "a.html") })).json();
  const r = await fetch(`${baseUrl}/session/${key}`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("x-frame-options"), "DENY");
  assert.match(r.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  const body = await r.text();
  assert.ok(body.includes('sandbox="allow-scripts allow-forms allow-popups"'));
  assert.ok(!body.includes("allow-same-origin"));
  assert.ok(body.includes("<title>My Plan</title>"));
  assert.ok(body.includes("Send to Agent"));
  assert.ok(body.includes("Send &amp; End"));
  assert.ok(body.includes('id="sendHint"'));
  assert.ok(/id="endedBanner"[^>]*hidden/.test(body) && body.includes(">Session ended<"));
  assert.ok(body.includes(`/artifact/${key}/index.html?rev=0`));
  assert.equal((await fetch(`${baseUrl}/session/0000000000000000`)).status, 404);
});

test("artifact index.html is original plus sdk tag, sandboxed", async (t) => {
  const { baseUrl, art, html } = await setup(t);
  const { key } = await (await post(baseUrl, { file: path.join(art, "a.html") })).json();
  const r = await fetch(`${baseUrl}/artifact/${key}/index.html`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-security-policy"), "sandbox allow-scripts allow-forms allow-popups; frame-ancestors 'self'");
  const asset = await fetch(`${baseUrl}/artifact/${key}/img/x.png`);
  assert.match(asset.headers.get("content-security-policy"), /^sandbox allow-scripts allow-forms allow-popups/);
  assert.match(asset.headers.get("content-security-policy"), /frame-ancestors 'self'/);
  assert.equal(await r.text(), injectSdk(html, key, 0));
  assert.equal((await fetch(`${baseUrl}/artifact/ffffffffffffffff/index.html`)).status, 404);
});

test("artifact assets: files served, traversal and directories 404", async (t) => {
  const { baseUrl, art, port } = await setup(t);
  const { key } = await (await post(baseUrl, { file: path.join(art, "a.html") })).json();
  assert.equal((await fetch(`${baseUrl}/artifact/${key}/img/x.png`)).status, 200);
  assert.equal((await fetch(`${baseUrl}/artifact/${key}/img`)).status, 404);
  assert.equal((await fetch(`${baseUrl}/artifact/${key}/nope.png`)).status, 404);
  for (const p of [
    `/artifact/${key}/%2e%2e/secret.txt`,
    `/artifact/${key}/..%2f..%2fsecret.txt`,
    `/artifact/${key}/..%2fsecret.txt`,
  ]) {
    const r = await rawGet(port, p);
    assert.equal(r.status, 404, p);
    assert.ok(!r.body.includes("SECRET"));
  }
});

test("origin guard", async (t) => {
  const { baseUrl, art } = await setup(t);
  const file = path.join(art, "a.html");
  assert.equal((await post(baseUrl, { file }, { Origin: "http://evil.example" })).status, 403);
  const r = await post(baseUrl, { file }, { Origin: "http://evil.example" });
  assert.equal((await r.json()).error.code, "FORBIDDEN_ORIGIN");
  assert.equal((await post(baseUrl, { file })).status, 200);
  assert.equal((await post(baseUrl, { file }, { Origin: baseUrl })).status, 200);
});

test("public files are served with no-cache", async (t) => {
  const { baseUrl } = await setup(t);
  for (const p of ["/sdk.js", "/chrome-client.js", "/chrome.css"]) {
    const r = await fetch(baseUrl + p);
    assert.equal(r.status, 200, p);
    assert.equal(r.headers.get("cache-control"), "no-cache");
  }
});

test("POST /shutdown replies ok", async (t) => {
  const { baseUrl } = await setup(t);
  const r = await fetch(baseUrl + "/shutdown", { method: "POST" });
  assert.deepEqual(await r.json(), { ok: true });
});
