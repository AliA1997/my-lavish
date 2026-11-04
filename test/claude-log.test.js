import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findLastPromptAt, findTranscript, listClaudeSessions, readTranscript, summarizeLine } from "../src/claude-log.js";
import { isClaudeSessionId } from "../src/claude-launcher.js";

const ID = "1b4e28ba-2fa1-11d2-883f-0016d3cca427";

async function fixture(t) {
  const claudeDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "mla-claude-"));
  t.after(() => fs.promises.rm(claudeDir, { recursive: true, force: true }));
  const projectDir = path.join(claudeDir, "projects", "C--x");
  await fs.promises.mkdir(projectDir, { recursive: true });
  return { claudeDir, file: path.join(projectDir, `${ID}.jsonl`) };
}

const line = (text) => JSON.stringify({ type: "user", message: { content: text }, timestamp: "t" }) + "\n";

test("summarizeLine maps text, tool_use and tool_result", () => {
  assert.deepEqual(summarizeLine({ type: "user", message: { content: "hi" }, timestamp: "t1" }), [
    { role: "user", kind: "text", text: "hi", at: "t1" },
  ]);
  const assistant = summarizeLine({
    type: "assistant",
    timestamp: "t2",
    message: {
      content: [
        { type: "thinking", thinking: "hmm" },
        { type: "text", text: "ok" },
        { type: "tool_use", name: "Bash", input: { command: "ls" } },
      ],
    },
  });
  assert.equal(assistant.length, 2);
  assert.equal(assistant[1].kind, "tool_use");
  assert.equal(assistant[1].text, 'Bash {"command":"ls"}');
  const result = summarizeLine({
    type: "user",
    message: { content: [{ type: "tool_result", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }] },
  });
  assert.equal(result[0].kind, "tool_result");
  assert.equal(result[0].text, "a\nb");
  assert.deepEqual(summarizeLine({ type: "attachment" }), []);
  assert.deepEqual(summarizeLine({ type: "user", isMeta: true, message: { content: "x" } }), []);
});

test("findTranscript finds the file in any project dir", async (t) => {
  const { claudeDir, file } = await fixture(t);
  await fs.promises.writeFile(file, line("hi"));
  assert.equal(await findTranscript(ID, { claudeDir }), file);
  assert.equal(await findTranscript("2b4e28ba-2fa1-11d2-883f-0016d3cca427", { claudeDir }), null);
});

test("isClaudeSessionId rejects traversal and findTranscript never touches the filesystem for it", async () => {
  assert.equal(isClaudeSessionId("../../etc"), false);
  assert.equal(isClaudeSessionId(ID), true);
  const original = fs.promises.readdir;
  fs.promises.readdir = async () => assert.fail("filesystem touched");
  try {
    assert.equal(await findTranscript("../../etc", { claudeDir: "/nope" }), null);
  } finally {
    fs.promises.readdir = original;
  }
});

test("partial last line is not consumed", async (t) => {
  const { file } = await fixture(t);
  const first = line("one");
  const second = line("two");
  await fs.promises.writeFile(file, first + second.slice(0, 12));
  const a = await readTranscript(file, {});
  assert.equal(a.entries.length, 1);
  assert.equal(a.next, Buffer.byteLength(first));
  await fs.promises.appendFile(file, second.slice(12));
  const b = await readTranscript(file, { after: a.next });
  assert.deepEqual(b.entries.map((e) => e.text), ["two"]);
});

test("reads at most maxBytes per call", async (t) => {
  const { file } = await fixture(t);
  const maxBytes = 256 * 1024;
  const rows = [];
  for (let i = 0; i < 30000; i++) rows.push(line(`entry ${i} ${"x".repeat(80)}`));
  await fs.promises.writeFile(file, rows.join(""));
  assert.ok((await fs.promises.stat(file)).size > 3 * 1024 * 1024);

  const reads = [];
  const originalOpen = fs.promises.open;
  fs.promises.open = async (...args) => {
    const handle = await originalOpen(...args);
    const read = handle.read.bind(handle);
    handle.read = (buf, off, len, pos) => {
      reads.push(len);
      return read(buf, off, len, pos);
    };
    return handle;
  };
  let tail;
  try {
    tail = await readTranscript(file, {});
  } finally {
    fs.promises.open = originalOpen;
  }
  assert.equal(tail.omitted, true);
  assert.ok(reads.length > 0 && reads.every((n) => n <= maxBytes));
  assert.ok(JSON.stringify(tail).length < maxBytes);
  assert.ok(tail.entries.at(-1).text.startsWith("entry 29999 "));
  assert.ok(!tail.entries.some((e) => e.text.startsWith("entry 0 ")));

  await fs.promises.appendFile(file, line("fresh"));
  const more = await readTranscript(file, { after: tail.next });
  assert.deepEqual(more.entries.map((e) => e.text), ["fresh"]);
});

test("a line longer than maxBytes is skipped, not stuck", async (t) => {
  const { file } = await fixture(t);
  await fs.promises.writeFile(file, line("y".repeat(300 * 1024)) + line("normal"));
  const maxBytes = 256 * 1024;
  let after = 0;
  const seen = [];
  for (let i = 0; i < 5 && !seen.includes("normal"); i++) {
    const r = await readTranscript(file, { after, maxBytes });
    assert.ok(r.next > after, "reader advanced");
    after = r.next;
    seen.push(...r.entries.map((e) => e.text.slice(0, 6)));
  }
  assert.ok(seen.includes("normal"));
});

test("after past end of file restarts at the tail", async (t) => {
  const { file } = await fixture(t);
  await fs.promises.writeFile(file, line("a") + line("b"));
  const r = await readTranscript(file, { after: 999999 });
  assert.deepEqual(r.entries.map((e) => e.text), ["a", "b"]);
  assert.equal(r.omitted, false);
});

test("summarizeLine names each entry by its line uuid and part", () => {
  const entries = summarizeLine({
    type: "assistant",
    uuid: "u-1",
    message: { content: [{ type: "text", text: "ok" }, { type: "tool_use", name: "Bash", input: {} }] },
  });
  assert.deepEqual(entries.map((e) => [e.uuid, e.part]), [["u-1", 0], ["u-1", 1]]);
});

test("listClaudeSessions lists the newest transcripts with cwd and title", async (t) => {
  const { claudeDir } = await fixture(t);
  const other = path.join(claudeDir, "projects", "C--y");
  await fs.promises.mkdir(path.join(other, "sub"), { recursive: true });
  const ids = ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002", "00000000-0000-4000-8000-000000000003"];
  const write = async (dir, id, lines, age) => {
    const file = path.join(dir, `${id}.jsonl`);
    await fs.promises.writeFile(file, lines.map((l) => JSON.stringify(l) + "\n").join(""));
    const when = new Date(Date.now() - age * 60000);
    await fs.promises.utimes(file, when, when);
  };
  const prompt = (content) => ({ type: "user", cwd: "C:\work\app", message: { content } });
  await write(path.join(claudeDir, "projects", "C--x"), ids[0], [{ type: "mode" }, prompt("<system-reminder>noise</system-reminder>fix   the\nbug")], 3);
  await write(other, ids[1], [prompt("first"), { type: "custom-title", customTitle: "Renamed" }], 1);
  await write(other, ids[2], [{ type: "mode" }], 2);
  await fs.promises.writeFile(path.join(other, "not-a-session.jsonl"), "{}\n");
  await write(path.join(other, "sub"), "00000000-0000-4000-8000-000000000009", [prompt("subagent")], 0);

  const all = await listClaudeSessions({ claudeDir });
  assert.deepEqual(all.map((s) => s.id), [ids[1], ids[2], ids[0]]);
  assert.deepEqual(all.map((s) => s.title), ["Renamed", "", "fix the bug"]);
  assert.equal(all[0].project, "C--y");
  assert.equal(all[2].cwd, "C:\work\app");
  assert.equal(all[1].cwd, null);
  assert.ok(!Number.isNaN(Date.parse(all[0].modified_at)));
  assert.deepEqual((await listClaudeSessions({ claudeDir, limit: 1 })).map((s) => s.id), [ids[1]]);
  assert.deepEqual(await listClaudeSessions({ claudeDir: path.join(claudeDir, "missing") }), []);
});

test("listClaudeSessions titles a session past built-in commands, but not past skills", async (t) => {
  const { claudeDir } = await fixture(t);
  const dir = path.join(claudeDir, "projects", "C--z");
  await fs.promises.mkdir(dir, { recursive: true });
  const caveat = { type: "user", isMeta: true, message: { content: "<local-command-caveat>Caveat: run directly.</local-command-caveat>" } };
  const cmd = (name, args = "") => ({ type: "user", message: { content: `<command-name>${name}</command-name>\n<command-message>${name.slice(1)}</command-message>\n<command-args>${args}</command-args>` } });
  const stdout = { type: "user", message: { content: "<local-command-stdout>Set model</local-command-stdout>" } };
  const said = (content) => ({ type: "user", message: { content } });
  const cases = [
    [[caveat, cmd("/model", "opus"), stdout, caveat, cmd("/clear"), said("fix the login bug")], "fix the login bug"],
    [[cmd("/interrogate-plan", "docs/plan.md"), said("1. yes")], "/interrogate-plan docs/plan.md"],
    [[caveat, cmd("/effort", "low"), stdout], "/effort low"],
  ];
  for (const [i, [lines]] of cases.entries()) {
    await fs.promises.writeFile(path.join(dir, `00000000-0000-4000-8000-00000000001${i}.jsonl`), lines.map((l) => JSON.stringify(l) + "\n").join(""));
  }
  const titles = Object.fromEntries((await listClaudeSessions({ claudeDir })).map((s) => [s.id.slice(-1), s.title]));
  assert.deepEqual([titles[0], titles[1], titles[2]], cases.map(([, title]) => title));
});

test("readTranscript reports when the last prompt was sent", async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "mla-lp-"));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "s.jsonl");
  const lines = [
    { type: "user", timestamp: "2026-01-01T00:00:00Z", message: { content: "first" } },
    { type: "user", timestamp: "2026-01-01T00:01:00Z", message: { content: "fix it" } },
    { type: "assistant", timestamp: "2026-01-01T00:02:00Z", message: { content: [{ type: "tool_use", name: "Bash", input: {} }] } },
    { type: "user", timestamp: "2026-01-01T00:03:00Z", message: { content: [{ type: "tool_result", content: "done" }] } },
    { type: "user", timestamp: "2026-01-01T00:04:00Z", isMeta: true, message: { content: "meta" } },
    { type: "user", timestamp: "2026-01-01T00:05:00Z", isCompactSummary: true, message: { content: "summary" } },
  ];
  await fs.promises.writeFile(file, lines.map((l) => JSON.stringify(l) + "\n").join(""));
  const all = await readTranscript(file);
  assert.equal(all.last_prompt_at, "2026-01-01T00:01:00Z");
  assert.equal((await readTranscript(file, { after: all.next })).last_prompt_at, null);
});

test("findLastPromptAt reads backwards past chunk boundaries", async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "mla-flp-"));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "s.jsonl");
  const big = (i) => ({ type: "assistant", timestamp: `2026-01-01T01:0${i}:00Z`, message: { content: [{ type: "text", text: "é".repeat(70000) }] } });
  const lines = [
    { type: "user", timestamp: "2026-01-01T00:00:00Z", message: { content: "older" } },
    { type: "user", timestamp: "2026-01-01T00:01:00Z", message: { content: "the last prompt" } },
    big(1), big(2), big(3), big(4), big(5),
    { type: "user", timestamp: "2026-01-01T02:00:00Z", message: { content: [{ type: "tool_result", content: "not typed" }] } },
  ];
  await fs.promises.writeFile(file, lines.map((l) => JSON.stringify(l) + "\n").join(""));
  const { size } = await fs.promises.stat(file);
  assert.ok(size > 600 * 1024, "spans several 256 KB chunks");
  assert.equal((await readTranscript(file)).last_prompt_at, null, "not in the tail window");
  assert.equal(await findLastPromptAt(file, size), "2026-01-01T00:01:00Z");
  assert.equal(await findLastPromptAt(file, size, { maxScan: 300 * 1024 }), null, "gives up past maxScan");
});
