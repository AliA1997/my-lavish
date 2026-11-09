import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
import { authHeaders, createServer, rawFetch } from "./helpers/authed-server.js";
import { SessionStore } from "../src/session-store.js";
import { readFeedback } from "../src/feedback-log.js";
import { createPollOutput } from "../src/cli.js";

async function setup(t, opts = {}) {
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "mla-wf-"));
  const stateDir = path.join(tmp, "state");
  const art = path.join(tmp, "art");
  await fs.promises.mkdir(art, { recursive: true });
  const file = path.join(art, "a.html");
  await fs.promises.writeFile(file, "<html><body><h1 id=t>hi</h1><p>one</p></body></html>");
  const launches = [];
  const make = () => createServer({
    store: new SessionStore(stateDir), stateDir, port: 0, version: "0.2.0", presenceGraceMs: 0,
    launchClaude: async (args) => { launches.push(args); return { mode: "powershell" }; },
    ...opts,
  });
  let srv = make();
  let { baseUrl, port } = await srv.listen();
  t.after(async () => {
    await srv.close();
    await fs.promises.rm(tmp, { recursive: true, force: true });
  });
  const ctx = { tmp, stateDir, art, file, launches };
  ctx.restart = async () => {
    await srv.close();
    srv = make();
    ({ baseUrl, port } = await srv.listen());
    ctx.baseUrl = baseUrl;
    ctx.port = port;
  };
  ctx.baseUrl = baseUrl;
  ctx.port = port;
  ctx.post = (p, body, { page = false } = {}) => fetch(ctx.baseUrl + p, {
    method: "POST",
    headers: { "content-type": "application/json", ...(page ? { Origin: ctx.baseUrl } : {}) },
    body: JSON.stringify(body),
  });
  ctx.get = async (p) => (await fetch(ctx.baseUrl + p)).json();
  ctx.open = async (f = file, extra = {}) => (await ctx.post("/api/sessions", { file: f, ...extra })).json();
  ctx.poll = (f = file, extra = {}) => ctx.post("/api/poll", { file: f, timeoutMs: 3000, ...extra }).then((r) => r.json());
  return ctx;
}

function ws(port, p) {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(`ws://127.0.0.1:${port}${p}`, { headers: authHeaders(port) });
    const messages = [];
    sock.on("message", (d) => messages.push(JSON.parse(String(d))));
    const waitFor = async (pred, ms = 3000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const m = messages.find(pred);
        if (m) return m;
        await delay(20);
      }
      throw new Error(`no matching message in ${JSON.stringify(messages)}`);
    };
    sock.once("open", () => resolve({ sock, messages, waitFor }));
    sock.once("error", reject);
  });
}

let seq = 0;
const note = (text, tag = "h1") => ({ prompt_id: `n-${++seq}`, prompt: text, tag, selector: "#t", text: "" });

test("session feedback is validated, queued, logged, and survives a restart", async (t) => {
  const c = await setup(t);
  const { key } = await c.open();
  assert.equal((await c.post(`/api/${key}/session-feedback`, { rating: "down" })).status, 403, "page origin only");
  assert.equal((await c.post(`/api/${key}/session-feedback`, { rating: "meh" }, { page: true })).status, 400);
  assert.equal((await c.post(`/api/${key}/session-feedback`, { rating: "down", categories: ["nope"] }, { page: true })).status, 400);
  const ok = await c.post(`/api/${key}/session-feedback`, { rating: "down", categories: ["too-slow", "ignored-notes"], text: "faster please" }, { page: true });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).chat.at(-1).anchor, "Session feedback");
  const records = await readFeedback(path.join(c.stateDir, "feedback.jsonl"));
  assert.deepEqual([records[0].kind, records[0].rating, records[0].categories], ["session", "down", ["too-slow", "ignored-notes"]]);

  await c.restart();
  const polled = await c.poll();
  assert.equal(polled.status, "feedback");
  const fb = polled.prompts[0];
  assert.equal(fb.tag, "session-feedback");
  assert.deepEqual(fb.target.categories, ["too-slow", "ignored-notes"]);
  const out = createPollOutput({ file: "a.html", response: polled });
  assert.match(out.next_step, /rated this session 👎 \(categories: Too slow, Ignored my notes\)/);
  assert.match(out.next_step, /Acknowledge it in your reply/);
});

test("approve ends the session as approved; unsent notes need force", async (t) => {
  const c = await setup(t);
  const { key } = await c.open();
  await c.post(`/api/${key}/prompts`, { prompts: [note("first")] }, { page: true });
  const refused = await c.post(`/api/${key}/decision`, { decision: "approve" }, { page: true });
  assert.equal(refused.status, 409);
  assert.equal((await refused.json()).error.code, "UNSENT_NOTES");
  assert.equal((await c.post(`/api/${key}/decision`, { decision: "approve" })).status, 403);
  assert.equal((await c.post(`/api/${key}/decision`, { decision: "approve", comment: "ship it", force: true }, { page: true })).status, 200);
  const polled = await c.poll();
  assert.equal(polled.ended_by, "approved");
  assert.equal(polled.prompts.at(-1).tag, "decision");
  const out = createPollOutput({ file: "a.html", response: polled });
  assert.equal(out.session.status, "approved");
  assert.match(out.next_step, /approved this plan\. First apply the 1 other prompt\(s\)\. Stop polling/);
  const status = await c.get(`/api/${key}/status`);
  assert.deepEqual([status.session.status, status.session.decision], ["ended", "approve"]);
});

test("request changes behaves like feedback with the comment first", async (t) => {
  const c = await setup(t);
  const { key } = await c.open();
  assert.equal((await c.post(`/api/${key}/decision`, { decision: "request-changes" }, { page: true })).status, 400, "needs a comment");
  await c.post(`/api/${key}/decision`, { decision: "request-changes", comment: "split step 2" }, { page: true });
  const polled = await c.poll();
  assert.equal(polled.status, "feedback");
  const out = createPollOutput({ file: "a.html", response: polled });
  assert.ok(out.next_step.startsWith("The user requested changes: address the `decision` prompt first."));
  assert.equal(polled.prompts[0].prompt, "Request changes: split step 2");
});

test("a whole-plan comment gets its own anchor", async (t) => {
  const c = await setup(t);
  const { key } = await c.open();
  const r = await (await c.post(`/api/${key}/prompts`, { prompts: [{ prompt_id: "w1", prompt: "Too long overall", tag: "plan", selector: "", text: "" }] }, { page: true })).json();
  assert.equal(r.chat.at(-1).anchor, "Whole plan");
});

test("status is read-only and never takes feedback", async (t) => {
  const c = await setup(t);
  const { key } = await c.open();
  await c.post(`/api/${key}/prompts`, { prompts: [note("keep me")] }, { page: true });
  const s = await c.get(`/api/${key}/status`);
  assert.deepEqual([s.session.queued_prompts, s.session.listening, s.session.revision], [1, false, 0]);
  assert.equal((await c.get(`/api/${key}/status`)).session.queued_prompts, 1);
  assert.equal((await c.poll()).prompts[0].prompt, "keep me");
});

test("stage labels: the panel sets human, the CLI sets flag, chat text infers", async (t) => {
  const c = await setup(t);
  const { key } = await c.open();
  const { sock, waitFor } = await ws(c.port, `/events/${key}`);
  t.after(() => sock.terminate());
  await c.post(`/api/${key}/prompts`, { prompts: [note("this is the interrogation", "chat")] }, { page: true });
  const inferred = await waitFor((m) => m.type === "stage");
  assert.deepEqual([inferred.stage, inferred.source], ["interrogation", "text"]);
  const human = await (await c.post(`/api/${key}/stage`, { stage: "plan" }, { page: true })).json();
  assert.deepEqual([human.stage, human.stage_source], ["plan", "human"]);
  await c.post(`/api/${key}/prompts`, { prompts: [note("let's implement it", "chat")] }, { page: true });
  assert.equal((await c.get(`/api/${key}/status`)).session.stage, "plan", "human label wins over inference");
  const flagged = await (await c.post(`/api/${key}/stage`, { stage: "verification" })).json();
  assert.deepEqual([flagged.stage, flagged.stage_source], ["verification", "flag"]);
  const polled = await c.poll(c.file, { timeoutMs: 50, stage: "implementation" });
  assert.deepEqual([polled.stage, polled.stage_source], ["implementation", "flag"]);
  assert.equal((await c.post("/api/poll", { file: c.file, stage: "bogus" })).status, 400);
});

test("revisions are kept, listed and served; a .md edit regenerates the page", async (t) => {
  const c = await setup(t);
  const md = path.join(c.art, "p.md");
  await fs.promises.writeFile(md, "# Plan\n\nstep one\n");
  const { ensurePlanHtml } = await import("../src/plan-markdown.js");
  const { htmlPath } = await ensurePlanHtml(md);
  const { key } = await c.open(htmlPath, { source_file: md });
  const { sock, waitFor } = await ws(c.port, `/events/${key}`);
  t.after(() => sock.terminate());
  await delay(300);
  await fs.promises.writeFile(md, "# Plan\n\nstep one\n\nstep two\n");
  const reload = await waitFor((m) => m.type === "reload", 5000);
  assert.equal(reload.revision, 1);
  assert.match(await fs.promises.readFile(htmlPath, "utf8"), /step two/);
  const list = await c.get(`/api/${key}/revisions`);
  assert.deepEqual(list.revisions.map((r) => r.n), [0, 1]);
  const r0 = await c.get(`/api/${key}/revisions/0`);
  assert.ok(r0.html.includes("step one") && !r0.html.includes("step two"));
  assert.equal((await fetch(`${c.baseUrl}/api/${key}/revisions/9`)).status, 404);
  assert.ok(fs.existsSync(path.join(c.stateDir, "revisions", key, "1.md")));
  assert.equal((await fetch(`${c.baseUrl}/api/${key}/revisions`, { headers: { "Sec-Fetch-Site": "cross-site" } })).status, 403);
});

test("start new session keeps earlier rounds in history; reopen keeps the chat", async (t) => {
  const c = await setup(t);
  const { key } = await c.open();
  await c.post(`/api/${key}/prompts`, { prompts: [note("round one")], end: true }, { page: true });
  assert.equal((await c.post(`/api/${key}/reopen`, {}, { page: true })).status, 200);
  const store = new SessionStore(c.stateDir);
  assert.equal((await store.getSession(key)).chat.length, 1, "reopen keeps history");
  await c.post(`/api/${key}/end`, {}, { page: true });
  await c.post(`/api/${key}/new-session`, {}, { page: true });
  const s = await store.getSession(key);
  assert.equal(s.chat.length, 0);
  assert.equal(s.history.length, 1);
  assert.equal(s.history[0].chat[0].text, "round one");
  assert.equal(s.history[0].ended_by, "user");
});

test("dashboard, session list, archive, prune, and home events", async (t) => {
  const c = await setup(t);
  const { key } = await c.open();
  const home = await fetch(c.baseUrl + "/");
  assert.equal(home.status, 200);
  const html = await home.text();
  assert.ok(html.includes('id="features"') && html.includes('src="/home-client.js"'));
  for (const asset of ["home-client.js", "home.css"]) assert.equal((await fetch(`${c.baseUrl}/${asset}`)).status, 200);
  const list = await c.get("/api/sessions");
  assert.deepEqual(Object.keys(list.sessions[0]).sort(), ["agent", "ended_by", "file", "key", "stage", "stage_source", "status", "updated_at", "url", "workflow_id"]);

  const { sock, messages, waitFor } = await ws(c.port, "/events/home");
  t.after(() => sock.terminate());
  await waitFor((m) => m.type === "sessions");
  const from = messages.length;
  await c.post(`/api/${key}/end`, {}, { page: true });
  await waitFor((m) => messages.indexOf(m) >= from && m.type === "sessions" && m.sessions[0]?.status === "ended");

  assert.equal((await c.post(`/api/${key}/archive`, {})).status, 403);
  assert.equal((await c.post(`/api/${key}/archive`, {}, { page: true })).status, 200);
  assert.equal((await c.get("/api/sessions")).sessions.length, 0);

  const gone = path.join(c.art, "gone.html");
  await fs.promises.writeFile(gone, "<html></html>");
  await c.open(gone);
  await fs.promises.rm(gone);
  const dry = await (await c.post("/api/prune", { dry_run: true })).json();
  assert.deepEqual(dry.removed.map((r) => path.basename(r.file)), ["gone.html"]);
  const done = await (await c.post("/api/prune", {})).json();
  assert.equal(done.removed.length, 1);
  assert.equal((await c.post("/api/prune", {})).status, 200);
  assert.equal((await (await c.post("/api/prune", {})).json()).removed.length, 0);
});

test("the four-stage workflow: gating, approve advances, verification can send back, skip", async (t) => {
  const c = await setup(t);
  const dir = path.join(c.tmp, "feature");
  await fs.promises.mkdir(dir);
  assert.equal((await c.post("/api/workflows", { name: "../x", dir, requirements: "r" })).status, 400);
  const created = await (await c.post("/api/workflows", { name: "auth", dir, requirements: "Users can log in." })).json();
  const real = await fs.promises.realpath(dir);
  assert.equal(created.stage, "plan");
  assert.ok(fs.existsSync(path.join(real, "auth.requirements.md")));
  assert.match(await fs.promises.readFile(path.join(real, "auth.plan.md"), "utf8"), /Claude is writing the plan/);
  const wf = created.workflow;
  assert.deepEqual(Object.values(wf.stages).map((s) => s.status), ["current", "locked", "locked", "locked"]);

  // Connect Claude for the Plan stage: a labeled, stage-specific prompt.
  const planKey = created.key;
  const launched = await (await c.post(`/api/${planKey}/connect-claude`, {})).json();
  const prompt = c.launches[0].prompt;
  assert.ok(prompt.startsWith("[see-plan · auth · Plan] "), prompt);
  assert.match(prompt, /auth\.requirements\.md/);
  assert.match(prompt, /--stage plan/);
  assert.match(prompt, /Do not start the next stage yourself/);
  assert.equal((await c.get(`/api/workflows/${wf.id}`)).workflow.stages.plan.claude_session_id, launched.claude_session_id);

  // A poll from the plan stage reports the workflow.
  const waiting = await c.poll(path.join(real, "auth.plan.md").replace(/\.md$/, ".html"), { timeoutMs: 50 });
  assert.deepEqual([waiting.stage, waiting.workflow.name, waiting.workflow.current], ["plan", "auth", "plan"]);

  // Approve the plan: interrogation opens and the page is told.
  const { sock, waitFor } = await ws(c.port, `/events/${planKey}`);
  t.after(() => sock.terminate());
  const approved = await (await c.post(`/api/${planKey}/decision`, { decision: "approve" }, { page: true })).json();
  assert.equal(approved.next, "interrogation");
  const ready = await waitFor((m) => m.type === "stage-ready");
  assert.equal(ready.next_url, approved.next_url);
  assert.ok(fs.existsSync(path.join(real, "auth.interrogation.html")));
  const interKey = approved.next_key;
  const after = (await c.get(`/api/workflows/${wf.id}`)).workflow;
  assert.deepEqual([after.stages.plan.status, after.stages.interrogation.status, after.current], ["done", "current", "interrogation"]);

  // Stage gating: implementation is still locked.
  await fs.promises.writeFile(path.join(real, "auth.progress.html"), "<html><body>p</body></html>");
  const early = await c.open(path.join(real, "auth.progress.html"));
  const store = new SessionStore(c.stateDir);
  await store.transact((state) => {
    Object.assign(state.sessions[early.key], { stage: "implementation", stage_source: "flag", workflow_id: wf.id });
    return [null, true];
  });
  const locked = await c.post(`/api/${early.key}/connect-claude`, {});
  assert.equal(locked.status, 409);
  assert.equal((await locked.json()).error.code, "STAGE_LOCKED");

  // Interrogation → skip → implementation opens.
  assert.equal((await c.post(`/api/workflows/${wf.id}/skip`, {})).status, 403);
  const skipped = await (await c.post(`/api/workflows/${wf.id}/skip`, {}, { page: true })).json();
  assert.equal(skipped.next, "implementation");
  assert.equal(skipped.workflow.stages.interrogation.status, "skipped");
  void interKey;
  const implKey = skipped.next_key;
  await (await c.post(`/api/${implKey}/connect-claude`, {})).json();
  assert.ok(c.launches.at(-1).prompt.startsWith("[see-plan · auth · Implementation] "));
  assert.match(c.launches.at(-1).prompt, /auth\.progress\.html/);

  // Implementation approved → verification; verification rejects → back to implementation with feedback.
  const toVerify = await (await c.post(`/api/${implKey}/decision`, { decision: "approve" }, { page: true })).json();
  assert.equal(toVerify.next, "verification");
  const verKey = toVerify.next_key;
  const back = await (await c.post(`/api/${verKey}/decision`, { decision: "request-changes", comment: "login fails on empty password" }, { page: true })).json();
  assert.equal(back.next, "implementation");
  assert.equal(back.next_key, implKey);
  const wf2 = (await c.get(`/api/workflows/${wf.id}`)).workflow;
  assert.deepEqual([wf2.current, wf2.stages.implementation.status, wf2.stages.verification.status], ["implementation", "current", "locked"]);
  const implSession = await store.getSession(implKey);
  assert.equal(implSession.status, "feedback");
  assert.match(implSession.prompts.at(-1).prompt, /Verification found issues: login fails on empty password/);

  // Finish: implementation approved again → verification approved → workflow done.
  const again = await (await c.post(`/api/${implKey}/decision`, { decision: "approve", force: true }, { page: true })).json();
  assert.equal(again.next, "verification");
  await c.post(`/api/${verKey}/reopen`, {}, { page: true }).catch(() => {});
  const fin = await (await c.post(`/api/${verKey}/decision`, { decision: "approve" }, { page: true })).json();
  assert.equal(fin.next, null, JSON.stringify(fin));
  assert.equal(fin.workflow.current, null);
  assert.ok(fin.workflow.completed_at);
});
