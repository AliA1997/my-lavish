import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionStore, sessionKey } from "../src/session-store.js";
import { Mutex } from "../src/async-mutex.js";

async function mk(t) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "mla-store-"));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  return dir;
}
const P = (id, extra = {}) => ({ prompt_id: id, prompt: "p" + id, tag: "chat", selector: "", text: "", ...extra });
const F = "C:\\a.html";
const B = "http://127.0.0.1:4388";

test("sessionKey is 16 hex and stable", () => {
  assert.match(sessionKey(F), /^[0-9a-f]{16}$/);
  assert.equal(sessionKey(F), sessionKey(F));
});

test("Mutex: rejected fn does not block the next", async () => {
  const m = new Mutex();
  await assert.rejects(m.runExclusive(async () => { throw new Error("x"); }));
  assert.equal(await m.runExclusive(async () => 5), 5);
});

test("upsert opened then resumed; url", async (t) => {
  const s = new SessionStore(await mk(t));
  const a = await s.upsertSession(F, B);
  const b = await s.upsertSession(F, B);
  assert.equal(a.status, "opened");
  assert.equal(b.status, "resumed");
  assert.equal(a.session.key, b.session.key);
  assert.equal(a.session.url, B + "/session/" + a.session.key);
  assert.equal(a.session.dir, path.dirname(F));
});

test("queue, take, waiting", async (t) => {
  const s = new SessionStore(await mk(t));
  const { session } = await s.upsertSession(F, B);
  assert.deepEqual(await s.queuePrompts(session.key, { prompts: [P("1"), P("2")], dom_snapshot: "<b>" }), { accepted: 2 });
  const r = await s.takeFeedback(session.key);
  assert.equal(r.status, "feedback");
  assert.deepEqual(r.prompts.map((p) => p.prompt_id), ["1", "2"]);
  assert.equal(r.dom_snapshot, "<b>");
  assert.deepEqual(await s.takeFeedback(session.key), { status: "waiting" });
  assert.deepEqual(await s.takeFeedback("nope"), { status: "missing" });
  assert.equal((await s.getSession(session.key)).status, "open");
});

test("chat anchors and idempotent retry", async (t) => {
  const s = new SessionStore(await mk(t));
  const { session } = await s.upsertSession(F, B);
  const k = session.key;
  await s.queuePrompts(k, { prompts: [P("1"), P("2", { tag: "text" }), P("3", { tag: "div", selector: "#x" })] });
  assert.deepEqual((await s.getSession(k)).chat.map((c) => c.anchor), ["", "text selection", "div #x"]);
  assert.deepEqual(await s.queuePrompts(k, { prompts: [P("1")] }), { accepted: 0 });
  assert.equal((await s.getSession(k)).chat.length, 3);
});

test("end via queue", async (t) => {
  const s = new SessionStore(await mk(t));
  const { session } = await s.upsertSession(F, B);
  const k = session.key;
  await s.queuePrompts(k, { prompts: [P("1")], end: true });
  const r = await s.takeFeedback(k);
  assert.equal(r.status, "feedback");
  assert.equal(r.session_ended, true);
  assert.equal(r.ended_by, "user");
  assert.deepEqual(await s.takeFeedback(k), { status: "ended", ended_by: "user" });
  await assert.rejects(s.queuePrompts(k, { prompts: [P("2")] }), (e) => e.code === "ENDED");
  await assert.rejects(s.queuePrompts("nope", { prompts: [] }), (e) => e.code === "MISSING");
});

test("reopen rules", async (t) => {
  const s = new SessionStore(await mk(t));
  const { session } = await s.upsertSession(F, B);
  const k = session.key;
  await s.endSession(k, "user");
  assert.equal((await s.upsertSession(F, B)).status, "user-ended");
  const r = await s.upsertSession(F, B, { reopen: true });
  assert.equal(r.status, "resumed");
  assert.equal(r.session.status, "open");
  await s.endSession(k, "agent");
  const r2 = await s.upsertSession(F, B);
  assert.equal(r2.status, "resumed");
  assert.equal(r2.session.status, "open");
});

test("restore prepends, no chat, dedupes against pending; ended stays ended", async (t) => {
  const s = new SessionStore(await mk(t));
  const { session } = await s.upsertSession(F, B);
  const k = session.key;
  await s.queuePrompts(k, { prompts: [P("A")], dom_snapshot: "snap" });
  await s.takeFeedback(k);
  await s.queuePrompts(k, { prompts: [P("B")] });
  assert.deepEqual(await s.queuePrompts(k, { prompts: [P("A")], dom_snapshot: "snap" }, { restore: true }), { accepted: 1 });
  assert.deepEqual(await s.queuePrompts(k, { prompts: [P("A")] }, { restore: true }), { accepted: 0 });
  assert.equal((await s.getSession(k)).chat.length, 2);
  const r = await s.takeFeedback(k);
  assert.deepEqual(r.prompts.map((p) => p.prompt_id), ["A", "B"]);
  assert.equal(r.dom_snapshot, "snap");
  await s.endSession(k, "agent");
  await s.queuePrompts(k, { prompts: [P("A")] }, { restore: true });
  const g = await s.getSession(k);
  assert.equal(g.status, "ended");
  assert.equal(g.ended_by, "agent");
  assert.equal((await s.takeFeedback(k)).session_ended, true);
});

test("agent reply, revision, persistence, corrupt", async (t) => {
  const dir = await mk(t);
  const s = new SessionStore(dir);
  const { session } = await s.upsertSession(F, B);
  const e = await s.appendAgentReply(session.key, "hi");
  assert.equal(e.role, "agent");
  assert.equal(await s.bumpRevision(session.key), 1);
  const s2 = new SessionStore(dir);
  assert.equal((await s2.getSession(session.key)).chat[0].text, "hi");
  assert.equal((await s2.listSessions()).length, 1);
  await fs.promises.writeFile(path.join(dir, "state.json"), "{not json");
  assert.deepEqual(await new SessionStore(dir).listSessions(), []);
});

test("20 concurrent queuePrompts", async (t) => {
  const s = new SessionStore(await mk(t));
  const { session } = await s.upsertSession(F, B);
  const rs = await Promise.all(Array.from({ length: 20 }, (_, i) => s.queuePrompts(session.key, { prompts: [P("c" + i)] })));
  assert.equal(rs.reduce((n, r) => n + r.accepted, 0), 20);
  assert.equal((await s.takeFeedback(session.key)).prompts.length, 20);
});

test("source_file must match the html", async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "mla-store-"));
  const store = new SessionStore(dir);
  const file = path.join(dir, "a.html");
  await assert.rejects(
    store.upsertSession(file, "http://x", { source_file: path.join(dir, "b.md") }),
    { code: "VALIDATION_ERROR" },
  );
  const { session } = await store.upsertSession(file, "http://x", { source_file: path.join(dir, "a.md") });
  assert.equal(session.source_file, path.join(dir, "a.md"));
  await fs.promises.rm(dir, { recursive: true, force: true });
});

async function endedStore(t) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "mla-store-"));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const store = new SessionStore(dir);
  const file = path.join(dir, "a.html");
  const { session } = await store.upsertSession(file, "http://x");
  return { store, key: session.key };
}

test("new session clears chat and reopens", async (t) => {
  const { store, key } = await endedStore(t);
  await store.appendAgentReply(key, "hello");
  await store.endSession(key, "user");
  const s = await store.startNewSession(key);
  assert.equal(s.status, "open");
  assert.equal(s.chat.length, 0);
  assert.equal("ended_by" in s, false);
});

test("new session keeps queued prompts", async (t) => {
  const { store, key } = await endedStore(t);
  await store.queuePrompts(key, { prompts: [{ prompt_id: "p1", prompt: "x", tag: "h1", selector: "#a", text: "" }], end: true });
  const s = await store.startNewSession(key);
  assert.equal(s.status, "feedback");
  assert.equal(s.prompts.length, 1);
  const taken = await store.takeFeedback(key);
  assert.equal(taken.status, "feedback");
  assert.equal(taken.prompts.length, 1);
});

test("new session on an open session is NOT_ENDED", async (t) => {
  const { store, key } = await endedStore(t);
  await assert.rejects(store.startNewSession(key), { code: "NOT_ENDED" });
});

test("claude-log prompts get their own anchor and keep the pending snapshot", async (t) => {
  const s = new SessionStore(await mk(t));
  const { session } = await s.upsertSession(F, B);
  const k = session.key;
  await s.queuePrompts(k, { prompts: [P("1")], dom_snapshot: "<page>" });
  await s.queuePrompts(k, { prompts: [P("claude-log:u:0", { tag: "claude-log" })], dom_snapshot: "" });
  assert.equal((await s.getSession(k)).chat.at(-1).anchor, "Claude log entry");
  const r = await s.takeFeedback(k);
  assert.equal(r.prompts.length, 2);
  assert.equal(r.dom_snapshot, "<page>");
});

test("plan-folder files get stage plan on create and on resume, never over a human label", async (t) => {
  const s = new SessionStore(await mk(t));
  const plan = path.join(os.tmpdir(), "repo", "docs", "superpowers", "plans", "2026-11-04-x.html");
  const md = path.join(os.tmpdir(), "repo", "docs", "superpowers", "plans", "2026-11-04-x.md");
  const created = await s.upsertSession(plan, B, { source_file: md });
  assert.deepEqual([created.session.stage, created.session.stage_source], ["plan", "path"]);

  // A session saved before 0.3.0 (no stage) is labelled on resume.
  const other = path.join(os.tmpdir(), "repo", "docs", "superpowers", "specs", "y.html");
  const first = await s.upsertSession(other, B);
  assert.equal(first.session.stage, "plan");
  await s.setStage(first.session.key, null, "human");
  await s.setStage(first.session.key, "implementation", "human");
  const resumed = await s.upsertSession(other, B);
  assert.deepEqual([resumed.session.stage, resumed.session.stage_source], ["implementation", "human"], "a human label is kept on resume");

  const third = path.join(os.tmpdir(), "repo", "docs", "superpowers", "plans", "z.html");
  const { session } = await s.upsertSession(third, B);
  await s.transact((state) => {
    delete state.sessions[session.key].stage;
    delete state.sessions[session.key].stage_source;
    return [null, true];
  });
  const again = await s.upsertSession(third, B);
  assert.deepEqual([again.session.stage, again.session.stage_source], ["plan", "path"], "inference runs on resume");
});
