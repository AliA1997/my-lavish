import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "../src/server.js";
import { SessionStore } from "../src/session-store.js";
import { createChromeHtml } from "../src/chrome-page.js";

async function setup(t) {
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "mla-pub-"));
  const stateDir = path.join(tmp, "state");
  const srv = createServer({ store: new SessionStore(stateDir), stateDir, port: 0, version: "0.1.0" });
  const { baseUrl } = await srv.listen();
  t.after(async () => {
    await srv.close();
    await fs.promises.rm(tmp, { recursive: true, force: true });
  });
  return { baseUrl };
}

async function fetchAsset(baseUrl, name) {
  const res = await fetch(`${baseUrl}/${name}`);
  assert.equal(res.status, 200, `${name} status`);
  return res.text();
}

test("server serves the three browser files", async (t) => {
  const { baseUrl } = await setup(t);
  for (const name of ["sdk.js", "chrome-client.js", "chrome.css"]) {
    await fetchAsset(baseUrl, name);
  }
});

test("browser scripts parse as classic scripts", async (t) => {
  const { baseUrl } = await setup(t);
  for (const name of ["sdk.js", "chrome-client.js"]) {
    const source = await fetchAsset(baseUrl, name);
    assert.doesNotThrow(() => new Function(source), `${name} has a syntax error`);
  }
});

test("sdk.js speaks the my-lavish message protocol", async (t) => {
  const { baseUrl } = await setup(t);
  const source = await fetchAsset(baseUrl, "sdk.js");
  assert.ok(source.includes('"my-lavish"'), "sdk.js tags messages with source \"my-lavish\"");
  assert.ok(source.includes("requestSnapshot"), "sdk.js answers requestSnapshot");
});

test("chrome-client.js checks the sender and assigns prompt ids", async (t) => {
  const { baseUrl } = await setup(t);
  const source = await fetchAsset(baseUrl, "chrome-client.js");
  assert.ok(source.includes("event.source"), "chrome-client.js checks event.source");
  assert.ok(source.includes("randomUUID"), "chrome-client.js assigns prompt_id with randomUUID");
});

test("new session button is on the page and wired in the client", async (t) => {
  const { baseUrl } = await setup(t);
  const html = createChromeHtml({ key: "k", file: "f.html", status: "ended", chat: [], revision: 0 }, { baseUrl });
  assert.ok(html.includes('id="newSession"'));
  assert.ok((await fetchAsset(baseUrl, "chrome-client.js")).includes("/new-session"));
});

test("presence text has its own span", async (t) => {
  const { baseUrl } = await setup(t);
  const html = createChromeHtml({ key: "k", file: "f.html", status: "open", chat: [], revision: 0 }, { baseUrl });
  const banner = /<div id="presenceBanner"[^>]*>([\s\S]*?)<\/div>/.exec(html)[1];
  assert.ok(banner.includes('id="presenceText"') && banner.includes('id="connectClaude"'));
  const source = await fetchAsset(baseUrl, "chrome-client.js");
  assert.ok(source.includes("presenceText.textContent"));
  assert.ok(!source.includes("presenceBanner.textContent"));
});
