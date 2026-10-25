import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findTranscript, readTranscript, summarizeLine } from "../src/claude-log.js";
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
