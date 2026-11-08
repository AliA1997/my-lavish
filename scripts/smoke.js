import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BIN = path.join(ROOT, "bin", "see-plan.js");
const EXAMPLE = path.join(ROOT, "examples", "plan.html");
// --bin <path>: drive a built single executable instead of `node bin/see-plan.js`.
const binIndex = process.argv.indexOf("--bin");
let EXE = binIndex >= 0 ? path.resolve(process.argv[binIndex + 1]) : null;
if (EXE && process.platform === "win32" && !EXE.endsWith(".exe") && fs.existsSync(`${EXE}.exe`)) EXE += ".exe";
const ASSETS = ["sdk.js", "chrome-client.js", "chrome.css", "logs-client.js", "logs.css", "home-client.js", "home.css", "errors-client.js", "errors.css"];

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function cli(args, env) {
  return new Promise((resolve, reject) => {
    const [cmd, argv] = EXE ? [EXE, args] : [process.execPath, [BIN, ...args]];
    execFile(cmd, argv, { env, timeout: 25000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`${args.join(" ")} failed: ${err.message}\n${stdout}\n${stderr}`));
      resolve(stdout);
    });
  });
}

function assert(cond, msg) {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

/** The token the server wrote to its runtime file (T2): smoke runs use it like any CLI (T8: no bypass). */
function runtime() {
  return JSON.parse(fs.readFileSync(path.join(stateDir, "server.json"), "utf8"));
}

/** fetch with the bearer token, unless `raw` (to check what a caller without it gets). */
function api(url, init = {}, { raw = false } = {}) {
  const headers = { ...(init.headers ?? {}) };
  if (!raw) headers.authorization = `Bearer ${runtime().token}`;
  return fetch(url, { ...init, headers });
}

async function jsonFetch(url, init) {
  const res = await api(url, init);
  const body = await res.json();
  assert(res.ok, `${init?.method ?? "GET"} ${url} answered ${res.status}: ${JSON.stringify(body)}`);
  return body;
}

const postJson = (baseUrl, p, body, headers = {}) =>
  api(baseUrl + p, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

const NOTE_TEXT = "Make the title bigger (smoke note text, never logged)";
const REASON_TEXT = "smoke reason text, never logged";

async function main(env, workDir) {
  const file = path.join(workDir, "plan.html");
  fs.copyFileSync(EXAMPLE, file);

  const opened = JSON.parse(await cli(["open", file, "--no-open", "--json"], env));
  assert(opened.server?.started === true && opened.server.mode === "hidden", `the open started the server hidden (S9): ${JSON.stringify(opened.server)}`);
  const url = new URL(opened.session.url);
  const key = url.pathname.split("/").filter(Boolean).pop();
  const baseUrl = url.origin;

  // T5: /health and static files are open; /health no longer leaks state_dir. Everything else needs the token.
  const health = await (await fetch(`${baseUrl}/health`)).json();
  assert(health.app === "my-lavish-axi" && health.auth === "token" && !("state_dir" in health), `health: ${JSON.stringify(health)}`);
  for (const a of ASSETS) assert((await fetch(`${baseUrl}/${a}`)).status === 200, `GET /${a} is open`);
  const noAuth = await fetch(`${baseUrl}/api/claude-errors`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer wrong-token-of-another-length" }, body: "{}" });
  const headerless = await fetch(`${baseUrl}/api/claude-errors`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert(headerless.status === 401 && (await headerless.json()).error.code === "AUTH_REQUIRED", "a header-less (curl-style) POST is refused with 401");
  assert(noAuth.status === 401, "a wrong bearer is refused");
  assert((await fetch(`${baseUrl}${url.pathname}`)).status === 401, "the session page without credentials is a 401 page");

  // Every page loads with the token.
  for (const p of [url.pathname, "/", "/claude", "/errors"]) {
    const res = await api(baseUrl + p);
    assert(res.status === 200, `GET ${p} answered ${res.status}`);
    assert((await res.text()).length > 0, `GET ${p} is empty`);
  }

  // T4: `see-plan url <file>` prints a one-time sign-in link; the browser trades it for an HttpOnly cookie.
  const signIn = JSON.parse(await cli(["url", file, "--json"], env));
  const link = new URL(signIn.url);
  assert(link.pathname === "/auth" && link.searchParams.get("next") === url.pathname, `sign-in link: ${signIn.url}`);
  const auth = await fetch(signIn.url, { redirect: "manual" });
  assert(auth.status === 303 && auth.headers.get("location") === url.pathname, `/auth answered ${auth.status}`);
  const setCookie = auth.headers.get("set-cookie") ?? "";
  assert(/HttpOnly/.test(setCookie) && /SameSite=Strict/.test(setCookie) && /Path=\//.test(setCookie), `cookie flags: ${setCookie}`);
  const cookie = setCookie.split(";")[0];
  leakChecks.cookie = cookie.split("=")[1];
  leakChecks.nonce = link.searchParams.get("t");
  assert((await fetch(signIn.url, { redirect: "manual" })).status === 401, "a sign-in link works once");
  const page = await fetch(`${baseUrl}${url.pathname}`, { headers: { cookie } });
  assert(page.status === 200, "the cookie opens the page");
  const html = await page.text();
  const cap = html.match(/\/artifact\/[0-9a-f]{16}\/([0-9a-f]{32})\/index\.html/)?.[1];
  assert(cap, "the page puts a capability in the artifact frame URL (T6)");
  assert((await fetch(`${baseUrl}/artifact/${key}/${cap}/index.html`)).status === 200, "the frame loads with the capability alone");
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${url.host}/events/${key}`, { headers: { cookie, origin: baseUrl } });
    ws.once("message", () => {
      ws.close();
      resolve();
    });
    ws.once("error", reject);
  });
  const wsRefused = await new Promise((resolve) => {
    const ws = new WebSocket(`ws://${url.host}/events/${key}`);
    ws.once("unexpected-response", (req, res) => resolve(res.statusCode));
    ws.once("open", () => resolve("open"));
    ws.once("error", () => resolve("error"));
  });
  assert(wsRefused === 401, `a WebSocket without the cookie is refused, got ${wsRefused}`);

  // The review loop.
  const pollPromise = cli(["poll", file, "--json"], env);
  await new Promise((r) => setTimeout(r, 500));
  const posted = await postJson(baseUrl, `/api/${key}/prompts`, {
    prompts: [{ prompt_id: "smoke-1", prompt: NOTE_TEXT, tag: "h1", selector: "h1", text: "Plan" }],
  }, { origin: baseUrl });
  assert(posted.status === 200, `POST prompts answered ${posted.status}: ${await posted.text()}`);
  const polled = JSON.parse(await pollPromise);
  assert(polled.prompts?.[0]?.prompt === NOTE_TEXT, "poll returned the posted prompt");
  await cli(["reply", file, "--agent-reply", "Done", "--json"], env);

  // S8: the server goes away during a poll (its window closed): the poll reconnects; the next poll sees the note.
  const waiting = cli(["poll", file, "--json"], env);
  await new Promise((r) => setTimeout(r, 700));
  process.kill(runtime().pid);
  const reconnected = JSON.parse(await waiting);
  assert(reconnected.session.status === "waiting" && reconnected.session.reconnect === true, `poll after a killed server: ${JSON.stringify(reconnected.session)}`);
  // A note queued while no server runs is impossible (the page needs it); one queued just before the kill is kept.
  const again = cli(["poll", file, "--json"], env);
  await new Promise((r) => setTimeout(r, 1500));
  await postJson(baseUrl, `/api/${key}/prompts`, { prompts: [{ prompt_id: "smoke-2", prompt: "After restart", tag: "h1", selector: "h1", text: "Plan" }] }, { origin: baseUrl });
  const second = JSON.parse(await again);
  assert(second.prompts?.[0]?.prompt === "After restart", `the restarted server delivers the note: ${JSON.stringify(second).slice(0, 200)}`);
  assert(second.server?.started === true, "the second poll restarted the server");

  await cli(["end", file, "--json"], env);
  await errorTabs(baseUrl, workDir, stateDir);
}

const PLAN_CLAUDE = "00000000-0000-4000-8000-00000000a001";
const PLAIN_CLAUDE = "00000000-0000-4000-8000-00000000a002";
const SEVERITIES = ["low", "medium", "high", "send_to_it"];

/** One entry of each severity from a plan session and from a plain session; then the /errors tabs count them. */
async function errorTabs(baseUrl, workDir, stateDir) {
  const post = (p, body, headers = {}) => jsonFetch(baseUrl + p, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const planFile = path.join(workDir, "docs", "superpowers", "plans", "smoke-plan.html");
  fs.mkdirSync(path.dirname(planFile), { recursive: true });
  fs.copyFileSync(EXAMPLE, planFile);
  const plan = JSON.parse(await cli(["open", planFile, "--no-open", "--json"], env));
  const planKey = new URL(plan.session.url).pathname.split("/").pop();
  const plainFile = path.join(workDir, "review.html");
  fs.copyFileSync(EXAMPLE, plainFile);
  const plainKey = new URL(JSON.parse(await cli(["open", plainFile, "--no-open", "--json"], env)).session.url).pathname.split("/").pop();
  await post(`/api/${planKey}/claude-session`, { id: PLAN_CLAUDE });
  await post(`/api/${plainKey}/claude-session`, { id: PLAIN_CLAUDE });
  for (const [claude, label] of [[PLAN_CLAUDE, "plan"], [PLAIN_CLAUDE, "plain"]]) {
    for (const [i, severity] of SEVERITIES.entries()) {
      const entry = { claude_session_id: claude, uuid: `${label}-${i}`, part: 0, role: "assistant", kind: "text", at: null, text: `${label} ${severity}`, severity, reason: REASON_TEXT };
      const logged = await post("/api/claude-errors", { entry }, { origin: baseUrl });
      assert(logged.status === "logged" && logged.severity === severity, `logged ${label} ${severity}`);
    }
  }
  // D9/D10: workDir is a project (a .git folder) with two superpowers plans; stateDir is not a project.
  fs.mkdirSync(path.join(workDir, ".git"), { recursive: true });
  fs.writeFileSync(path.join(path.dirname(planFile), "2026-11-04-smoke-second.md"), "# Second smoke plan\n");
  const inProject = JSON.parse(await cli(["error-logs", "--dir", workDir, "--no-open", "--json"], env)).error_logs;
  assert(inProject.mode === "project" && /\/errors\?project=[0-9a-f]{16}$/.test(inProject.url), `error-logs in a project: ${JSON.stringify(inProject)}`);
  const projectKey = new URL(inProject.url).searchParams.get("project");
  const elsewhere = JSON.parse(await cli(["error-logs", "--dir", stateDir, "--no-open", "--json"], env)).error_logs;
  assert(elsewhere.mode === "sessions-only" && elsewhere.url === `${baseUrl}/errors`, `error-logs elsewhere: ${JSON.stringify(elsewhere)}`);
  const tabCount = async (u) => ((await (await api(u)).text()).match(/role="tab"/g) ?? []).length;
  assert((await tabCount(inProject.url)) === 4, "a project's /errors has four tabs");
  assert((await tabCount(`${baseUrl}/errors`)) === 1, "/errors outside a project has only Sessions");
  const summary = await jsonFetch(`${baseUrl}/api/errors/summary?project=${projectKey}`);
  for (const context of ["session", "plan"]) {
    const c = summary.counts[context];
    assert(c.all === 4 && SEVERITIES.every((s) => c[s] === 1) && c.unrated === 0, `${context} counts: ${JSON.stringify(c)}`);
    const list = await jsonFetch(`${baseUrl}/api/errors?context=${context}`);
    assert(list.total === 4 && list.items.every((i) => i.context === context), `${context} error tab lists 4`);
  }
  const plans = await jsonFetch(`${baseUrl}/api/projects/${projectKey}/plans`);
  const opened = plans.items.find((p) => p.name === "smoke-plan.html");
  const second = plans.items.find((p) => p.name === "2026-11-04-smoke-second.md");
  assert(plans.items.length === 2 && opened?.review_key === planKey && opened.error_count === 4 && opened.worst_severity === "send_to_it", `plans tab: ${JSON.stringify(plans.items)}`);
  assert(second?.status === "Not opened" && second.title === "Second smoke plan", `unopened plan: ${JSON.stringify(second)}`);
  assert(summary.plans === 2, "plans tab count");
  const sessions = await jsonFetch(`${baseUrl}/api/claude-sessions?limit=75`);
  assert(sessions.sessions.length === 2, `sessions tab lists the 2 Claude sessions, got ${sessions.sessions.length}`);
  const planRow = sessions.sessions.find((s) => s.id === PLAN_CLAUDE);
  assert(planRow?.review_key === planKey && planRow.stage === "plan" && planRow.error_count === 4, "sessions tab links the plan session");
}

/** S4 leak test: the server's log never holds the token, a nonce, the cookie, sign-in links or note text. */
function checkLogLeaks(secrets) {
  const log = fs.existsSync(path.join(stateDir, "server.log")) ? fs.readFileSync(path.join(stateDir, "server.log"), "utf8") : "";
  assert(/session opened: plan\.html/.test(log) && /feedback sent: 1 note/.test(log), "server.log has the event lines");
  for (const [name, value] of Object.entries(secrets)) {
    if (value) assert(!log.includes(value), `server.log must not contain the ${name}`);
  }
  assert(!/\/auth\?t=[A-Za-z0-9_-]{8,}/.test(log), "server.log must not contain a sign-in link");
  assert(!log.includes(NOTE_TEXT) && !log.includes(REASON_TEXT) && !log.includes("After restart"), "server.log must not contain note text");
}

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "my-lavish-smoke-state-"));
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "my-lavish-smoke-work-"));
// A private Claude dir and error log: the smoke run never touches ~/.claude or the real error log.
const claudeDir = path.join(stateDir, "claude");
fs.mkdirSync(path.join(claudeDir, "projects", "smoke"), { recursive: true });
for (const id of [PLAN_CLAUDE, PLAIN_CLAUDE]) {
  fs.writeFileSync(path.join(claudeDir, "projects", "smoke", `${id}.jsonl`), JSON.stringify({ type: "user", message: { content: `smoke ${id}` } }) + "\n");
}
const port = await freePort();
const env = {
  ...process.env,
  MY_LAVISH_STATE_DIR: stateDir,
  MY_LAVISH_PORT: String(port),
  MY_LAVISH_NO_OPEN: "1",
  MY_LAVISH_SERVER_WINDOW: "hidden", // CI never opens windows (3.13)
  MY_LAVISH_ERROR_LOG: path.join(stateDir, "claude-errors", "error-log.json"),
  CLAUDE_CONFIG_DIR: claudeDir,
};

let failure = null;
const seenTokens = new Set();
const leakChecks = {};
const timer = setTimeout(() => {
  console.error("smoke timed out after 60s");
  cli(["stop"], env).catch(() => {}).finally(() => process.exit(1));
}, 60000);
const tokenWatch = setInterval(() => {
  try {
    seenTokens.add(runtime().token);
  } catch {}
}, 50);

try {
  await main(env, workDir);
} catch (e) {
  failure = e;
} finally {
  try {
    seenTokens.add(runtime().token);
  } catch {}
  clearInterval(tokenWatch);
  try {
    await cli(["stop", "--json"], env);
  } catch (e) {
    failure ??= e;
  }
  if (!failure) {
    try {
      checkLogLeaks({ ...leakChecks, ...Object.fromEntries([...seenTokens].map((t, i) => [`token #${i + 1}`, t])) });
    } catch (e) {
      failure = e;
    }
  }
  clearTimeout(timer);
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.rmSync(stateDir, { recursive: true, force: true });
}

if (failure) {
  console.error(failure.stack ?? String(failure));
  process.exit(1);
}
console.log(EXE ? `SMOKE OK (${path.basename(EXE)})` : "SMOKE OK");
