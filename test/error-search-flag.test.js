import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createServer } from "./helpers/authed-server.js";
import { LocalErrorStore, createErrorStore, errorSearchEnabled, pineconeSettings } from "../src/error-store.js";
import { SessionStore } from "../src/session-store.js";

test("the flags are off by default, and a key alone turns nothing on", async (t) => {
  assert.equal(errorSearchEnabled({}), false);
  assert.equal(errorSearchEnabled({ PINECONE_API_KEY: "k" }), false);
  assert.equal(errorSearchEnabled({ USE_ERROR_SEARCH: "yes" }), false, "only true counts");
  assert.equal(errorSearchEnabled({ USE_ERROR_SEARCH: "TRUE" }), true);
  assert.equal(errorSearchEnabled({ USE_PINECONE: "true" }), true);
  assert.equal(pineconeSettings({ PINECONE_API_KEY: "k" }).on, false);
  assert.ok((await createErrorStore({ file: "x.json", env: { PINECONE_API_KEY: "k" } })) instanceof LocalErrorStore);
});

async function serve(t, errorSearch) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "mla-flag-"));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  const srv = createServer({ store: new SessionStore(dir), stateDir: dir, port: 0, idleTimeoutMs: 0, version: "t", claudeDir: path.join(dir, "c"), errorLogFile: path.join(dir, "e.json"), errorSearch });
  const { port } = await srv.listen();
  t.after(() => srv.close());
  return `http://127.0.0.1:${port}`;
}

test("search routes answer 404 FEATURE_OFF unless the flag is on", async (t) => {
  const off = await serve(t, undefined);
  for (const p of ["/api/errors/similar?q=x", "/api/errors/store"]) {
    const res = await fetch(off + p);
    assert.equal(res.status, 404, p);
    assert.equal((await res.json()).error.code, "FEATURE_OFF");
  }
  const on = await serve(t, true);
  assert.equal((await fetch(`${on}/api/errors/similar?q=x`)).status, 200);
  assert.equal((await fetch(`${on}/api/errors/store`)).status, 200);
});
