import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  POWERSHELL_PATH,
  buildClaudeLaunch,
  findClaude,
  findRepoRoot,
  isClaudeSessionId,
  launchClaude,
} from "../src/claude-launcher.js";

const ID = "1b4e28ba-2fa1-11d2-883f-0016d3cca427";
const SCRIPT = `& $env:SEE_PLAN_CLAUDE --session-id ${ID} $env:SEE_PLAN_PROMPT`;
const decode = (b64) => Buffer.from(b64, "base64").toString("utf16le");

test("buildClaudeLaunch encodes the claude command", () => {
  const l = buildClaudeLaunch({ file: "C:\\p\\plan.md", sessionId: ID, claudePath: "C:\\bin\\claude.exe", env: {} });
  assert.deepEqual(l.args.slice(0, 2), ["-NoExit", "-EncodedCommand"]);
  assert.equal(decode(l.args[2]), SCRIPT);
  assert.ok(path.isAbsolute(l.command));
  assert.match(l.command, /System32[\\/]WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/);
  assert.equal(l.env.SEE_PLAN_CLAUDE, "C:\\bin\\claude.exe");
  assert.equal(
    l.env.SEE_PLAN_PROMPT,
    "This is a see-plan review session for the file C:\\p\\plan.md. Run see-plan poll on that file (quote the path for your shell) and follow its next_step.",
  );
});

test("buildClaudeLaunch keeps paths out of the script", () => {
  const file = "C:\\O'Brien\\x\u2019; calc; \u2019\\$(calc)\\p.md";
  const l = buildClaudeLaunch({ file, sessionId: ID, claudePath: "C:\\c.exe", env: {} });
  assert.equal(decode(l.args[2]), SCRIPT);
  assert.ok(l.env.SEE_PLAN_PROMPT.includes(file));
});

test("buildClaudeLaunch rejects a non-uuid session id", () => {
  assert.throws(() => buildClaudeLaunch({ file: "f", sessionId: "x; calc", claudePath: "c" }), { code: "VALIDATION_ERROR" });
  assert.equal(isClaudeSessionId("../../etc"), false);
  assert.equal(isClaudeSessionId(ID), true);
});

const fakeWhere = (stdout, err = null) => (cmd, args, opts, cb) => cb(err, stdout);

test("findClaude prefers exe over cmd", async () => {
  const out = "C:\\a\\claude.ps1\r\nC:\\a\\claude.cmd\r\nC:\\a\\claude.exe\r\n";
  assert.equal(await findClaude({ execFileFn: fakeWhere(out) }), "C:\\a\\claude.exe");
  assert.equal(await findClaude({ execFileFn: fakeWhere("C:\\a\\claude.ps1\r\nC:\\a\\claude.cmd\r\n") }), "C:\\a\\claude.cmd");
});

test("findClaude refuses a ps1-only install", async () => {
  await assert.rejects(findClaude({ execFileFn: fakeWhere("C:\\a\\claude.ps1\r\n") }), (e) => {
    assert.equal(e.code, "CLAUDE_NOT_FOUND");
    assert.match(e.message, /execution policy/);
    return true;
  });
});

test("findClaude returns null when where fails", async () => {
  assert.equal(await findClaude({ execFileFn: fakeWhere("", new Error("exit 1")) }), null);
});

test("findRepoRoot walks up to .git", async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "mla-repo-"));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const deep = path.join(root, "a", "b");
  await fs.promises.mkdir(deep, { recursive: true });
  await fs.promises.mkdir(path.join(root, ".git"));
  assert.equal(await findRepoRoot(deep), root);
});

test("findRepoRoot falls back to the dir", async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "mla-norepo-"));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const found = await findRepoRoot(root);
  // A .git above the temp dir would change the answer; accept the dir or an ancestor that has one.
  assert.ok(found === root || fs.existsSync(path.join(found, ".git")));
});

test("launchClaude refuses off Windows", async () => {
  await assert.rejects(launchClaude({ file: "f", cwd: ".", sessionId: ID }, { platform: "linux" }), { code: "UNSUPPORTED_PLATFORM" });
});

test("launchClaude reports a missing claude", async () => {
  await assert.rejects(
    launchClaude({ file: "f", cwd: ".", sessionId: ID }, { platform: "win32", findClaude: async () => null }),
    { code: "CLAUDE_NOT_FOUND" },
  );
});

test("launchClaude spawns detached powershell", async () => {
  const calls = [];
  let unrefs = 0;
  const spawnFn = (command, args, opts) => {
    calls.push({ command, args, opts });
    return { on() {}, unref: () => unrefs++ };
  };
  await launchClaude(
    { file: "C:\\p\\plan.md", cwd: "C:\\p", sessionId: ID },
    { platform: "win32", spawnFn, findClaude: async () => "C:\\c\\claude.exe" },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, POWERSHELL_PATH);
  assert.equal(calls[0].opts.cwd, "C:\\p");
  assert.equal(calls[0].opts.detached, true);
  assert.equal(calls[0].opts.stdio, "ignore");
  assert.equal(calls[0].opts.env.SEE_PLAN_CLAUDE, "C:\\c\\claude.exe");
  assert.ok(!calls[0].args.some((a) => /dangerously/.test(a)));
  assert.equal(unrefs, 1);
});
