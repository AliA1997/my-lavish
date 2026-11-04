import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

function postPrompts(baseUrl, key, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      `${baseUrl}/api/${key}/prompts`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload), origin: baseUrl },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

function assert(cond, msg) {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

async function main(env, workDir) {
  const file = path.join(workDir, "plan.html");
  fs.copyFileSync(EXAMPLE, file);

  const opened = JSON.parse(await cli(["open", file, "--no-open", "--json"], env));
  const url = new URL(opened.session.url);
  const key = url.pathname.split("/").filter(Boolean).pop();
  const baseUrl = url.origin;

  // The page, the dashboard, and every browser file load from this build's server.
  for (const p of [url.pathname, "/", "/claude", "/errors", ...ASSETS.map((a) => `/${a}`)]) {
    const res = await fetch(baseUrl + p);
    assert(res.status === 200, `GET ${p} answered ${res.status}`);
    assert((await res.text()).length > 0, `GET ${p} is empty`);
  }
  const health = await (await fetch(`${baseUrl}/health`)).json();
  assert(health.app === "my-lavish-axi", "health names the app");

  const pollPromise = cli(["poll", file, "--json"], env);
  await new Promise((r) => setTimeout(r, 500));
  const posted = await postPrompts(baseUrl, key, {
    prompts: [{ prompt_id: "smoke-1", prompt: "Make the title bigger", tag: "h1", selector: "h1", text: "Plan" }],
  });
  assert(posted.status === 200, `POST prompts answered ${posted.status}: ${posted.text}`);

  const polled = JSON.parse(await pollPromise);
  assert(polled.prompts?.[0]?.prompt === "Make the title bigger", "poll returned the posted prompt");

  await cli(["reply", file, "--agent-reply", "Done", "--json"], env);
  await cli(["end", file, "--json"], env);

  await errorTabs(baseUrl, workDir, stateDir);
}

const PLAN_CLAUDE = "00000000-0000-4000-8000-00000000a001";
const PLAIN_CLAUDE = "00000000-0000-4000-8000-00000000a002";
const SEVERITIES = ["low", "medium", "high", "send_to_it"];

async function jsonFetch(url, init) {
  const res = await fetch(url, init);
  const body = await res.json();
  assert(res.ok, `${init?.method ?? "GET"} ${url} answered ${res.status}: ${JSON.stringify(body)}`);
  return body;
}

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
      const entry = { claude_session_id: claude, uuid: `${label}-${i}`, part: 0, role: "assistant", kind: "text", at: null, text: `${label} ${severity}`, severity, reason: `smoke ${severity}` };
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
  const tabCount = async (u) => ((await (await fetch(u)).text()).match(/role="tab"/g) ?? []).length;
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

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "my-lavish-smoke-state-"));
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "my-lavish-smoke-work-"));
// A private Claude dir and error log: the smoke run never touches ~/.claude or ~/claude-errors.
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
  MY_LAVISH_ERROR_LOG: path.join(stateDir, "claude-errors", "error-log.json"),
  CLAUDE_CONFIG_DIR: claudeDir,
};

let failure = null;
const timer = setTimeout(() => {
  console.error("smoke timed out after 30s");
  cli(["stop"], env).catch(() => {}).finally(() => process.exit(1));
}, 30000);

try {
  await main(env, workDir);
} catch (e) {
  failure = e;
} finally {
  try {
    await cli(["stop", "--json"], env);
  } catch (e) {
    failure ??= e;
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
