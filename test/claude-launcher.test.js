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
  buildPrompt,
  claudeStatus,
  OSASCRIPT_PATH,
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
  assert.ok(l.env.SEE_PLAN_PROMPT.startsWith("[see-plan · plan · Review] This is a see-plan review session for the file C:\\p\\plan.md. Run see-plan poll on that file (quote the path for your shell) and follow its next_step."));
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
  assert.equal(await findClaude({ platform: "win32", execFileFn: fakeWhere(out) }), "C:\\a\\claude.exe");
  assert.equal(await findClaude({ platform: "win32", execFileFn: fakeWhere("C:\\a\\claude.ps1\r\nC:\\a\\claude.cmd\r\n") }), "C:\\a\\claude.cmd");
});

test("findClaude refuses a ps1-only install", async () => {
  await assert.rejects(findClaude({ platform: "win32", execFileFn: fakeWhere("C:\\a\\claude.ps1\r\n") }), (e) => {
    assert.equal(e.code, "CLAUDE_NOT_FOUND");
    assert.match(e.message, /execution policy/);
    return true;
  });
});

test("findClaude returns null when where fails", async () => {
  assert.equal(await findClaude({ platform: "win32", execFileFn: fakeWhere("", new Error("exit 1")) }), null);
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

test("launchClaude refuses unknown platforms", async () => {
  await assert.rejects(launchClaude({ file: "f", cwd: ".", sessionId: ID }, { platform: "aix" }), { code: "UNSUPPORTED_PLATFORM" });
});

const HOSTILE = "/tmp/O'Brien\\x’; calc; ’\\$(calc)/p.md";

test("the launch prompt carries the label and explains the 1:50 reconnect cycle", () => {
  const p = buildPrompt({ file: "/r/auth.plan.md", feature: "auth", stage: "interrogation" });
  assert.ok(p.startsWith("[see-plan · auth · Interrogation] "));
  assert.match(p, /--stage interrogation/);
  assert.match(p, /1:50 with reconnect: true; run it again right away/);
  assert.ok(!/dangerously/.test(p));
});

test("macOS launch passes the prompt and path via env, never in the script", () => {
  const l = buildClaudeLaunch({ file: HOSTILE, sessionId: ID, claudePath: "/usr/local/bin/claude", env: {}, platform: "darwin", cwd: HOSTILE });
  assert.equal(l.command, OSASCRIPT_PATH);
  const script = l.args.filter((a, i) => i % 2 === 1).join("\n");
  assert.ok(!script.includes("O'Brien") && !script.includes("calc"));
  assert.match(script, /quoted form of \(system attribute "SEE_PLAN_PROMPT"\)/);
  assert.ok(l.env.SEE_PLAN_PROMPT.includes(HOSTILE));
  assert.equal(l.env.SEE_PLAN_CWD, HOSTILE);
});

test("Linux picks the first terminal, or falls back to a copy command", async () => {
  const calls = [];
  const spawnFn = (command, args, opts) => { calls.push({ command, args, opts }); return { on() {}, unref() {} }; };
  const find = async () => "/usr/bin/claude";
  const which = async (n) => (n === "gnome-terminal" || n === "xterm" ? `/usr/bin/${n}` : null);
  const r = await launchClaude({ file: HOSTILE, cwd: "/r", sessionId: ID }, { platform: "linux", spawnFn, findClaude: find, which });
  assert.equal(r.mode, "terminal");
  assert.equal(calls[0].command, "/usr/bin/gnome-terminal");
  assert.deepEqual(calls[0].args.slice(0, 4), ["--", "/usr/bin/claude", "--session-id", ID]);
  assert.ok(calls[0].args[4].includes(HOSTILE), "the path is one argv item");
  const none = await launchClaude({ file: "/r/p.md", cwd: "/r", sessionId: ID }, { platform: "linux", spawnFn, findClaude: find, which: async () => null });
  assert.equal(none.mode, "copy");
  assert.match(none.command, /^cd '\/r' && '\/usr\/bin\/claude' --session-id /);
  assert.equal(calls.length, 1, "copy mode spawns nothing");
});

test("resume uses --resume with the validated id", async () => {
  const l = buildClaudeLaunch({ file: "f", sessionId: ID, claudePath: "c", env: {}, resume: true });
  assert.equal(decode(l.args[2]), `& $env:SEE_PLAN_CLAUDE --resume ${ID} $env:SEE_PLAN_PROMPT`);
  assert.throws(() => buildClaudeLaunch({ file: "f", sessionId: "--x", claudePath: "c", resume: true }), { code: "VALIDATION_ERROR" });
});

test("claudeStatus reports how a launch would work", async () => {
  const find = async () => "/usr/bin/claude";
  assert.deepEqual(await claudeStatus({ platform: "win32", findClaude: async () => "C:\\c.exe" }), { platform: "win32", launch: "powershell", claude_found: true, claude_path: "C:\\c.exe" });
  assert.equal((await claudeStatus({ platform: "darwin", findClaude: find })).launch, "osascript");
  assert.equal((await claudeStatus({ platform: "linux", findClaude: find, which: async () => "/usr/bin/xterm" })).launch, "terminal");
  const none = await claudeStatus({ platform: "linux", findClaude: async () => null, which: async () => null });
  assert.deepEqual([none.launch, none.claude_found], ["copy", false]);
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
