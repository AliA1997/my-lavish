import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { BOOL_FLAGS, createOpenOutput, createPollOutput, pollingAgent, run, VALUE_FLAGS } from "../src/cli.js";
import { HOME_USAGE } from "../src/guidance.js";

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
  assert.match(a.stdout(), /playbooks\[8\]\{id,use_when\}:/);
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
  assert.match(out.next_step, /see-plan stop/);
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

test("next_step strings name see-plan", () => {
  const out = createPollOutput({ file: "f.html", response: { status: "waiting" } });
  assert.match(out.next_step, /`see-plan poll f\.html`/);
  assert.doesNotMatch(JSON.stringify(out), /my-lavish-axi/);
});

test("package bin is see-plan", async () => {
  const pkg = JSON.parse(await fs.promises.readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.deepEqual(pkg.bin, { "see-plan": "bin/see-plan.js" });
});

async function mdEnv(t) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "mla-cli-md-"));
  const env = { ...process.env, MY_LAVISH_STATE_DIR: dir, MY_LAVISH_PORT: String(await freePort()), MY_LAVISH_NO_OPEN: "1" };
  t.after(async () => {
    await run(["stop"], fakeIo(env).io).catch(() => {});
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  });
  return { dir, env };
}

test("open accepts a .md file", async (t) => {
  const { dir, env } = await mdEnv(t);
  const md = path.join(dir, "notes.md");
  await fs.promises.writeFile(md, "# Notes");
  const o = fakeIo(env);
  assert.equal(await run(["notes.md".replace("notes.md", md), "--no-open", "--json"], o.io), 0);
  assert.match(JSON.parse(o.stdout()).session.file, /notes\.md$/);
  assert.ok(fs.existsSync(path.join(dir, "notes.html")));
  const state = JSON.parse(await fs.promises.readFile(path.join(dir, "state.json"), "utf8"));
  const [s] = Object.values(state.sessions);
  assert.match(s.file, /notes\.html$/);
  assert.match(s.source_file, /notes\.md$/);
});

test("opening generated html maps back to its md", async (t) => {
  const { dir, env } = await mdEnv(t);
  const md = path.join(dir, "notes.md");
  await fs.promises.writeFile(md, "# Notes");
  assert.equal(await run([md, "--no-open", "--json"], fakeIo(env).io), 0);
  const o = fakeIo(env);
  assert.equal(await run([path.join(dir, "notes.html"), "--no-open", "--json"], o.io), 0);
  assert.match(JSON.parse(o.stdout()).session.file, /notes\.md$/);
  const state = JSON.parse(await fs.promises.readFile(path.join(dir, "state.json"), "utf8"));
  assert.match(Object.values(state.sessions)[0].source_file, /notes\.md$/);

  await fs.promises.writeFile(md, "# Changed heading");
  const later = new Date(Date.now() + 5000);
  await fs.promises.utimes(md, later, later);
  const p = fakeIo(env);
  assert.equal(await run(["poll", path.join(dir, "notes.html"), "--timeout-ms", "200", "--json"], p.io), 0);
  assert.match(await fs.promises.readFile(path.join(dir, "notes.html"), "utf8"), /Changed heading/);
});

test("poll next_step names the md", () => {
  const out = createPollOutput({ file: "notes.md", response: { status: "feedback", prompts: [{ prompt: "x" }] } });
  assert.match(out.next_step, /Apply each prompt to `notes\.md`/);
  assert.doesNotMatch(out.next_step, /HTML file in place/);
});

test("open --with-claude prints the claude session id", async (t) => {
  const { dir, file } = await tmpHtml(t);
  const id = "1b4e28ba-2fa1-11d2-883f-0016d3cca427";
  const seen = [];
  const port = await fakeServer(t, (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/health") return res.end(JSON.stringify({ ok: true, app: "my-lavish-axi" }));
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (req.url === "/api/sessions") return res.end(JSON.stringify({ status: "opened", key: "abc", url: "http://x/session/abc" }));
      seen.push({ url: req.url, type: req.headers["content-type"], body: Buffer.concat(chunks).toString() });
      res.end(JSON.stringify({ ok: true, claude_session_id: id }));
    });
  });
  const a = fakeIo({ MY_LAVISH_STATE_DIR: dir, MY_LAVISH_PORT: String(port) });
  assert.equal(await run(["open", file, "--with-claude", "--json"], a.io), 0);
  const out = JSON.parse(a.stdout());
  assert.equal(out.session.claude_session_id, id);
  assert.match(out.next_step, /do not poll from here/);
  assert.deepEqual(seen, [{ url: "/api/abc/connect-claude", type: "application/json", body: "{}" }]);
});

test("poll --claude-session rejects a bad id", async (t) => {
  const { dir, file } = await tmpHtml(t);
  let requests = 0;
  const port = await fakeServer(t, (req, res) => {
    requests++;
    res.end("{}");
  });
  const a = fakeIo({ MY_LAVISH_STATE_DIR: dir, MY_LAVISH_PORT: String(port) });
  assert.equal(await run(["poll", file, "--claude-session", "nope", "--json"], a.io), 1);
  assert.equal(JSON.parse(a.stdout()).error.code, "VALIDATION_ERROR");
  assert.equal(requests, 0);
});

const logPrompt = { prompt: "Add this Claude log entry", tag: "claude-log", target: { entry: { text: "boom" } } };

test("poll next_step for claude-log prompts no longer asks the agent to write files", () => {
  const home = path.join("C:", "Users", "me");
  const log = path.join(home, "claude-errors", "error-log.json");
  const only = createPollOutput({ file: "f.html", home, response: { status: "feedback", prompts: [logPrompt] } });
  assert.ok(only.next_step.includes(`\`${log}\``));
  assert.match(only.next_step, /One prompt is tagged `claude-log`/);
  assert.match(only.next_step, /already wrote them/);
  assert.match(only.next_step, /do not write that file yourself/);
  assert.match(only.next_step, /Then poll again with `see-plan poll f\.html --agent-reply/);
  assert.doesNotMatch(only.next_step, /Apply/);

  const mixed = createPollOutput({ file: "f.html", home, response: { status: "feedback", prompts: [logPrompt, logPrompt, { prompt: "x", tag: "h1" }] } });
  assert.match(mixed.next_step, /2 prompts are tagged/);
  assert.match(mixed.next_step, /Apply the other prompts to the HTML file in place/);

  const ended = createPollOutput({ file: "f.html", home, response: { status: "feedback", session_ended: true, prompts: [logPrompt] } });
  assert.ok(ended.next_step.includes(log));
  assert.match(ended.next_step, /Report what you did in chat, and do not poll again\.$/);
});

test("pollingAgent reports Claude Code and its session id", () => {
  const id = "1b4e28ba-2fa1-11d2-883f-0016d3cca427";
  const flagged = "2b4e28ba-2fa1-11d2-883f-0016d3cca427";
  assert.deepEqual(pollingAgent(undefined, {}), {});
  assert.deepEqual(pollingAgent(undefined, { CLAUDE_CODE_SESSION_ID: id }), {}, "needs CLAUDECODE=1");
  assert.deepEqual(pollingAgent(undefined, { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: id }), { agent: "claude", claude_session_id: id });
  assert.deepEqual(pollingAgent(undefined, { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "../x" }), { agent: "claude" });
  assert.deepEqual(pollingAgent(flagged, { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: id }), { agent: "claude", claude_session_id: flagged });
});

test("poll sends the agent and its Claude session with the request", async (t) => {
  const { dir, file } = await tmpHtml(t);
  const id = "1b4e28ba-2fa1-11d2-883f-0016d3cca427";
  const bodies = [];
  const port = await fakeServer(t, (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/health") return res.end(JSON.stringify({ ok: true, app: "my-lavish-axi" }));
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      bodies.push({ url: req.url, body: JSON.parse(Buffer.concat(chunks).toString() || "{}") });
      res.end(JSON.stringify({ status: "waiting" }));
    });
  });
  const a = fakeIo({ MY_LAVISH_STATE_DIR: dir, MY_LAVISH_PORT: String(port), CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: id });
  assert.equal(await run(["poll", file, "--json"], a.io), 0);
  assert.deepEqual(bodies.map((b) => b.url), ["/api/poll"], "no separate attach request");
  assert.equal(bodies[0].body.agent, "claude");
  assert.equal(bodies[0].body.claude_session_id, id);

  const b = fakeIo({ MY_LAVISH_STATE_DIR: dir, MY_LAVISH_PORT: String(port) });
  assert.equal(await run(["poll", file, "--json"], b.io), 0);
  assert.equal("agent" in bodies[1].body, false);
});

test("logs prints the Claude log page; bare see-plan opens it only from a terminal", async (t) => {
  const { env } = await mdEnv(t);
  const l = fakeIo(env);
  assert.equal(await run(["logs", "--json"], l.io), 0);
  const { logs } = JSON.parse(l.stdout());
  assert.deepEqual(logs, { url: `http://127.0.0.1:${env.MY_LAVISH_PORT}/claude`, status: "ready" });
  assert.equal((await fetch(logs.url)).status, 200);

  const agent = fakeIo(env);
  assert.equal(await run(["--json"], agent.io), 0);
  assert.equal(JSON.parse(agent.stdout()).claude_logs, undefined, "agents run without a TTY");

  const human = fakeIo(env);
  human.io.stdout.isTTY = true;
  assert.equal(await run(["--json"], human.io), 0);
  assert.equal(JSON.parse(human.stdout()).claude_logs, logs.url);
});

test("poll defaults to 110000 ms under Claude Code; explicit --timeout-ms wins", async (t) => {
  const { dir, file } = await tmpHtml(t);
  const bodies = [];
  const port = await fakeServer(t, (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/health") return res.end(JSON.stringify({ ok: true, app: "my-lavish-axi" }));
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      bodies.push(JSON.parse(Buffer.concat(chunks).toString() || "{}"));
      res.end(JSON.stringify({ status: "waiting", reconnect: true }));
    });
  });
  const base = { MY_LAVISH_STATE_DIR: dir, MY_LAVISH_PORT: String(port) };
  assert.equal(await run(["poll", file, "--json"], fakeIo({ ...base, CLAUDECODE: "1" }).io), 0);
  assert.equal(bodies[0].timeoutMs, 110000);
  assert.equal(await run(["poll", file, "--json"], fakeIo(base).io), 0);
  assert.equal("timeoutMs" in bodies[1], false, "humans keep the unlimited poll");
  assert.equal(await run(["poll", file, "--json", "--timeout-ms", "30000"], fakeIo({ ...base, CLAUDECODE: "1" }).io), 0);
  assert.equal(bodies[2].timeoutMs, 30000);
  assert.equal(await run(["poll", file, "--json", "--agent"], fakeIo(base).io), 0);
  assert.equal(bodies[3].agent, "agent");
  assert.equal(bodies[3].timeoutMs, 110000);
});

test("waiting next_step is a routine reconnect", () => {
  const out = createPollOutput({ file: "f.html", response: { status: "waiting", reconnect: true } });
  assert.equal(out.session.reconnect, true);
  assert.ok(out.next_step.includes("`see-plan poll f.html`"));
  assert.match(out.next_step, /run `see-plan poll f\.html` again now/i);
  assert.match(out.next_step, /do not reply to the user/i);
  assert.doesNotMatch(out.next_step, /--timeout-ms/);
  assert.ok(Buffer.byteLength(JSON.stringify(out)) < 300);
});

test("open next_step explains the cycle", () => {
  const out = createOpenOutput({ file: "f.html", url: "u", status: "opened", knowsOwnSession: true });
  assert.match(out.next_step, /1:50/);
  assert.match(out.next_step, /run it again each time/);
  assert.doesNotMatch(out.next_step, /--claude-session/);
  assert.match(createOpenOutput({ file: "f.html", url: "u", status: "opened" }).next_step, /--claude-session/);
});

test("HOME_USAGE lists every flag", () => {
  for (const flag of [...VALUE_FLAGS, ...BOOL_FLAGS]) {
    if (flag === "-h") continue;
    assert.ok(HOME_USAGE.includes(flag), flag);
  }
});

test("status, stage, feature, and prune commands", async (t) => {
  const { dir, env } = await mdEnv(t);
  const file = path.join(dir, "auth-interrogation.html");
  await fs.promises.writeFile(file, "<html><body>q</body></html>");
  const json = async (args) => {
    const io = fakeIo(env);
    const code = await run([...args, "--json"], io.io);
    return { code, out: JSON.parse(io.stdout()) };
  };
  assert.equal((await json(["open", file])).code, 0);
  const st = await json(["status", file]);
  assert.deepEqual([st.out.session.status, st.out.session.stage, st.out.session.stage_source, st.out.session.queued_prompts], ["open", "interrogation", "path", 0]);
  assert.match(st.out.next_step, /see-plan poll/);
  const set = await json(["stage", file, "verification"]);
  assert.deepEqual([set.out.session.stage, set.out.session.stage_source], ["verification", "flag"]);
  assert.equal((await json(["stage", file, "bogus"])).code, 1);
  assert.equal((await json(["stage", file])).out.session.stage, "verification");

  const reqs = path.join(dir, "reqs.md");
  await fs.promises.writeFile(reqs, "Users can log in.");
  const started = await json(["feature", "start", "login", "--requirements", reqs, "--dir", dir]);
  assert.equal(started.code, 0, JSON.stringify(started.out));
  assert.equal(started.out.feature.current, "plan");
  assert.deepEqual(started.out.feature.stages.map((s) => s.status), ["current", "locked", "locked", "locked"]);
  assert.match(started.out.next_step, /--stage plan/);
  const fs1 = await json(["feature", "status", "login"]);
  assert.match(fs1.out.next_step, /Current stage: Plan/);
  assert.equal((await json(["feature", "status", "nope"])).code, 1);

  await fs.promises.rm(file);
  const dry = await json(["prune", "--dry-run"]);
  assert.deepEqual(dry.out.removed.map((f) => path.basename(f)), ["auth-interrogation.html"]);
  assert.equal((await json(["prune"])).out.removed.length, 1);
  assert.equal((await json(["status", file])).code, 1);

  const help = fakeIo(env);
  await run(["--help"], help.io);
  for (const cmd of ["status", "stage", "feature", "prune"]) assert.ok(help.stdout().includes(`see-plan ${cmd}`), cmd);
});
