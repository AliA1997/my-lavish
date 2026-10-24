import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
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
    await new Promise((r) => setTimeout(r, 200));
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
