import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createPollOutput, run } from "../src/cli.js";

function fakeIo(env = {}) {
  const out = [];
  const err = [];
  return {
    io: {
      stdout: { write: (s) => out.push(s) },
      stderr: { write: (s) => err.push(s) },
      env: { MY_LAVISH_NO_OPEN: "1", ...env },
    },
    stdout: () => out.join(""),
    stderr: () => err.join(""),
  };
}

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

test("poll output key order", () => {
  const out = createPollOutput({
    file: "f",
    response: { status: "feedback", prompts: [{ prompt: "x" }], dom_snapshot: "<html>" },
  });
  assert.deepEqual(Object.keys(out), ["session", "prompts", "next_step", "dom_snapshot"]);
});

test("poll output next_step variants", () => {
  const ended = createPollOutput({
    file: "f",
    response: { status: "feedback", prompts: [{ prompt: "x" }], session_ended: true },
  });
  assert.ok(!ended.next_step.includes("poll f"));
  assert.match(ended.next_step, /chat/);
  const e = createPollOutput({ file: "f", response: { status: "ended" } });
  assert.match(e.next_step, /do not reopen/i);
});

test("playbook listing and unknown id", async () => {
  const a = fakeIo();
  assert.equal(await run(["playbook"], a.io), 0);
  assert.match(a.stdout(), /playbooks\[5\]\{id,use_when\}:/);
  const b = fakeIo();
  assert.equal(await run(["playbook", "nope"], b.io), 1);
  assert.match(b.stdout(), /NOT_FOUND/);
});

test("open of a missing file is a validation error", async () => {
  const a = fakeIo();
  assert.equal(await run(["open", "missing.html"], a.io), 1);
  assert.match(a.stdout(), /VALIDATION_ERROR/);
});

test("open, poll and stop against a spawned server", async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "mla-cli-"));
  const env = {
    ...process.env,
    MY_LAVISH_STATE_DIR: dir,
    MY_LAVISH_PORT: String(await freePort()),
    MY_LAVISH_NO_OPEN: "1",
  };
  t.after(async () => {
    await run(["stop"], fakeIo(env).io).catch(() => {});
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  });
  const file = path.join(dir, "page.html");
  await fs.promises.writeFile(file, "<html><body>hi</body></html>");

  const o = fakeIo(env);
  assert.equal(await run(["open", file, "--json"], o.io), 0);
  assert.equal(JSON.parse(o.stdout()).session.status, "opened");

  const p = fakeIo(env);
  assert.equal(await run(["poll", file, "--timeout-ms", "300", "--json"], p.io), 0);
  assert.equal(JSON.parse(p.stdout()).session.status, "waiting");

  const s = fakeIo(env);
  assert.equal(await run(["stop"], s.io), 0);
});

async function fakeServer(t, handler) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => { server.close(() => r()); server.closeAllConnections?.(); }));
  return server.address().port;
}

async function tmpHtml(t) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "mla-cli-"));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {}));
  const file = path.join(dir, "page.html");
  await fs.promises.writeFile(file, "<html><body>hi</body></html>");
  return { dir, file };
}

test("poll reports LISTENER_ACTIVE on 409", async (t) => {
  const { dir, file } = await tmpHtml(t);
  const port = await fakeServer(t, (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/health") return res.end(JSON.stringify({ ok: true, app: "my-lavish-axi" }));
    req.resume();
    res.statusCode = 409;
    res.end(JSON.stringify({ error: { code: "LISTENER_ACTIVE", message: "busy" } }));
  });
  const a = fakeIo({ MY_LAVISH_STATE_DIR: dir, MY_LAVISH_PORT: String(port) });
  assert.equal(await run(["poll", file, "--agent-reply", "x", "--json"], a.io), 1);
  const out = JSON.parse(a.stdout());
  assert.equal(out.error.code, "LISTENER_ACTIVE");
  assert.match(out.next_step, /another poll is already listening/i);
  assert.match(out.next_step, /re-send your reply/i);
  assert.match(out.next_step, /my-lavish-axi stop/);
});

test("diagram playbook does not tell agents to annotate via data-lavish-action", async () => {
  const a = fakeIo();
  assert.equal(await run(["playbook", "diagram"], a.io), 0);
  assert.doesNotMatch(a.stdout(), /data-lavish-action so the human can point/);
  assert.match(a.stdout(), /unique id/);
});

test("next_step quotes paths with spaces, leaves plain paths alone", () => {
  const q = createPollOutput({ file: "C:\\my dir\\a.html", response: { status: "waiting" } });
  assert.ok(q.next_step.includes('poll "C:\\\\my dir\\\\a.html"'));
  const p = createPollOutput({ file: "f", response: { status: "waiting" } });
  assert.ok(p.next_step.includes("poll f`"));
});

test("invalid MY_LAVISH_PORT is a VALIDATION_ERROR", async () => {
  const a = fakeIo({ MY_LAVISH_PORT: "abc" });
  assert.equal(await run(["stop", "--json"], a.io), 1);
  const out = JSON.parse(a.stdout());
  assert.equal(out.error.code, "VALIDATION_ERROR");
  assert.match(out.error.message, /MY_LAVISH_PORT/);
});

test("open reports PORT_IN_USE when another app owns the port", async (t) => {
  const { dir, file } = await tmpHtml(t);
  const port = await fakeServer(t, (req, res) => res.end("not json"));
  const a = fakeIo({ MY_LAVISH_STATE_DIR: dir, MY_LAVISH_PORT: String(port) });
  assert.equal(await run(["open", file, "--json"], a.io), 1);
  assert.equal(JSON.parse(a.stdout()).error.code, "PORT_IN_USE");
  assert.equal(fs.existsSync(path.join(dir, "server.log")), false, "no server spawned");
});

test("poll rejects both reply flags", async (t) => {
  const { file } = await tmpHtml(t);
  const a = fakeIo();
  assert.equal(await run(["poll", file, "--agent-reply", "x", "--agent-reply-file", "y", "--json"], a.io), 1);
  assert.equal(JSON.parse(a.stdout()).error.code, "VALIDATION_ERROR");
});
