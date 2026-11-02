import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { toToon } from "./toon.js";
import { assertHtmlFile, canonicalFile } from "./artifact-path.js";
import { isClaudeSessionId } from "./claude-launcher.js";
import { ensurePlanHtml, generatedSourceFor, htmlPathFor, isMarkdownPath } from "./plan-markdown.js";
import { SessionStore, sessionKey } from "./session-store.js";
import { createServer } from "./server.js";
import { DESIGN_TEXT, PLAYBOOKS, HOME_USAGE } from "./guidance.js";

const APP = "my-lavish-axi";
export const CMD = "see-plan";
const BIN_PATH = fileURLToPath(new URL("../bin/see-plan.js", import.meta.url));
const PACKAGE_PATH = fileURLToPath(new URL("../package.json", import.meta.url));

class CliError extends Error {
  constructor(code, message, nextStep) {
    super(message);
    this.code = code;
    this.nextStep = nextStep;
  }
}

class Interrupted extends Error {}

// ---------- config (always from the env passed in) ----------

function configOf(env) {
  const rawPort = env.MY_LAVISH_PORT;
  const port = rawPort === undefined || rawPort === "" ? 4388 : Number(rawPort);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new CliError("VALIDATION_ERROR", `MY_LAVISH_PORT must be an integer 0-65535, got "${rawPort}"`, "Fix or unset MY_LAVISH_PORT and retry.");
  }
  const stateDir = env.MY_LAVISH_STATE_DIR || path.join(os.homedir(), ".my-lavish-axi");
  const rawIdle = env.MY_LAVISH_IDLE_TIMEOUT_MS;
  let idleTimeoutMs = 1800000;
  if (rawIdle !== undefined && rawIdle !== "") {
    idleTimeoutMs = rawIdle === "off" ? 0 : Number(rawIdle);
    if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs < 0) idleTimeoutMs = 1800000;
  }
  return { port, stateDir, idleTimeoutMs };
}

// ---------- pure output builders ----------

export function shellQuote(p) {
  return /[\s"'`$&|;<>()*?!#~^%{}\[\]\\]/.test(p) ? JSON.stringify(p) : p;
}

const POLL_CMD = (file) => `${CMD} poll ${shellQuote(file)}`;
/** Agent polls end on their own after this long (under Claude Code's default 120 s Bash timeout). */
export const AGENT_POLL_MS = 110000;

export function createOpenOutput({ file, url, status, claudeSessionId, knowsOwnSession = false }) {
  const session = { file, url, status };
  if (claudeSessionId) session.claude_session_id = claudeSessionId;
  return {
    session,
    next_step: claudeSessionId
      ? "Claude was started in a new terminal window and will poll this session; do not poll from here."
      :
      `Do not respond to the user yet. Run \`${POLL_CMD(file)}\` now. ` +
      "It stays silent until the user sends feedback, and returns about every 1:50 with `reconnect: true` so your Bash timeout never kills it: run it again each time. " +
      `After applying feedback, run \`${POLL_CMD(file)} --agent-reply "<short summary>"\`.` +
      (knowsOwnSession ? "" : " If you know your Claude session id, pass `--claude-session <id>` so the user can follow your log."),
  };
}

export function createUserEndedOutput({ file }) {
  return {
    session: { file, status: "user-ended" },
    next_step:
      "The user ended this session. Give any updates in chat and do not poll. " +
      `Use \`see-plan ${shellQuote(file)} --reopen\` only if the user asks to reopen it.`,
  };
}

/** Prompts tagged claude-log are Claude log entries the user clicked in the panel. */
function errorLogStep(count, home) {
  const log = path.join(home, "claude-errors", "error-log.json");
  return `${count === 1 ? "One prompt is" : `${count} prompts are`} tagged \`claude-log\`: Claude log entries the user flagged. ` +
    `Append each one's \`target.entry\`, plus a \`reported_at\` ISO timestamp, to the JSON array in \`${log}\` ` +
    "(create the folder, and the file as `[]`, if missing; keep the records already there). ";
}

export function createPollOutput({ file, response, home = os.homedir() }) {
  const markdown = isMarkdownPath(file);
  const status = response.status;
  const out = { session: { file, status } };
  if (response.ended_by) out.session.ended_by = response.ended_by;
  if (response.session_ended) out.session.session_ended = true;
  if (response.prompts) out.prompts = response.prompts;
  if (status === "feedback") {
    const prompts = response.prompts ?? [];
    const logged = prompts.filter((p) => p?.tag === "claude-log").length;
    const logStep = logged ? errorLogStep(logged, home) : "";
    const edits = prompts.length > logged;
    const which = logged ? "the other prompts" : "each prompt";
    const again = `poll again with \`${POLL_CMD(file)} --agent-reply "<short summary>"\``;
    out.next_step = response.session_ended
      ? `The user ended the session with this feedback. ${logStep}${edits ? `Apply the changes to ${markdown ? `\`${file}\`` : "the HTML file"}, report` : "Report"} what you did in chat, and do not poll again.`
      : logStep + (!edits
        ? `Then ${again}.`
        : markdown
          ? `Apply ${which} to \`${file}\` (the HTML is generated from it; \`selector\` refers to the rendered page), then ${again}.`
          : `Apply ${which} to the HTML file in place (\`selector\` says where), then ${again}.`);
  } else if (status === "ended") {
    out.next_step = "The session is ended. Stop polling and do not reopen it unless the user asks.";
  } else if (status === "waiting") {
    if (response.reconnect) out.session.reconnect = true;
    out.next_step = response.reconnect
      ? `Routine reconnect (every 1:50, so your Bash timeout never kills the poll). Run \`${POLL_CMD(file)}\` again now. Do not reply to the user.`
      : `No feedback yet. Run \`${POLL_CMD(file)}\` again now. Do not reply to the user.`;
  } else {
    out.next_step = `Unexpected status "${status}". Re-run \`${POLL_CMD(file)}\`.`;
  }
  if (response.dom_snapshot) out.dom_snapshot = response.dom_snapshot;
  return out;
}

export function createHomeOutput({ sessions, logsUrl }) {
  return {
    sessions: sessions.map(({ file, status, url }) => ({ file, status, url })),
    ...(logsUrl ? { claude_logs: logsUrl } : {}),
    usage: HOME_USAGE,
    next_step: "Open an HTML artifact with `see-plan <file.html>`, or read `see-plan design` and `see-plan playbook` before writing one.",
  };
}

// ---------- http ----------

function request(baseUrl, method, urlPath, { body, timeoutMs, signalHandle } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      baseUrl + urlPath,
      {
        method,
        headers: payload === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {}
          resolve({ status: res.statusCode, body: json });
        });
        res.on("error", reject);
      },
    );
    if (timeoutMs) req.setTimeout(timeoutMs, () => req.destroy(new Error("request timed out")));
    req.on("error", reject);
    signalHandle?.(req);
    req.end(payload);
  });
}

async function api(baseUrl, method, urlPath, opts) {
  let res;
  try {
    res = await request(baseUrl, method, urlPath, opts);
  } catch (e) {
    throw new CliError("SERVER_UNAVAILABLE", `Could not reach the server at ${baseUrl}: ${e.message}`, "Re-run the command; it starts the server if needed. Check server.log in the state dir if it keeps failing.");
  }
  return res;
}

function httpError(res, file) {
  const code = res.body?.error?.code;
  if (res.status === 404 && res.body?.status === "missing") {
    return new CliError("NOT_FOUND", `No session for ${file}`, `Run \`see-plan ${shellQuote(file)}\` to open it first.`);
  }
  if (code === "LISTENER_ACTIVE") {
    return new CliError(
      code,
      res.body.error.message ?? "Another poll is already listening",
      "Another poll is already listening for this file. If that poll is yours and still running, wait for it. If no poll of yours is running (a killed shell can leave an orphan), run `see-plan stop` (restarts the server and releases the stale listener), then re-run poll and re-send your reply with that poll (this reply was not recorded).",
    );
  }
  return new CliError(
    code ?? "SERVER_ERROR",
    res.body?.error?.message ?? `Server answered HTTP ${res.status}`,
    "Fix the problem described and retry.",
  );
}

async function probeHealth(baseUrl) {
  return new Promise((resolve) => {
    const req = http.get(`${baseUrl}/health`, { timeout: 1000 }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        res.destroy();
        try {
          resolve({ up: true, health: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
        } catch {
          resolve({ up: true, health: null });
        }
      });
      res.on("error", () => resolve({ up: true, health: null }));
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve({ up: false }));
    req.on("close", () => req.socket?.destroy());
  });
}

export async function ensureServer(env) {
  const { port, stateDir } = configOf(env);
  const baseUrl = `http://127.0.0.1:${port}`;
  const portInUse = () =>
    new CliError("PORT_IN_USE", `Port ${port} is used by another application`, "Set MY_LAVISH_PORT to a free port and retry.");

  const first = await probeHealth(baseUrl);
  if (first.up) {
    if (first.health?.app === APP) return baseUrl;
    throw portInUse();
  }

  await fs.promises.mkdir(stateDir, { recursive: true });
  const logFd = fs.openSync(path.join(stateDir, "server.log"), "a");
  let child;
  try {
    child = spawn(process.execPath, [BIN_PATH, "server"], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      windowsHide: true,
      env,
    });
  } finally {
    fs.closeSync(logFd);
  }
  child.on("error", () => {});
  child.unref();

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    const p = await probeHealth(baseUrl);
    if (p.up) {
      if (p.health?.app === APP) return baseUrl;
      throw portInUse();
    }
  }
  throw new CliError("SERVER_UNAVAILABLE", `Server did not start within 5s on ${baseUrl}`, `Check ${path.join(stateDir, "server.log")} for the reason.`);
}

// ---------- argument parsing ----------

export const VALUE_FLAGS = new Set(["--agent-reply", "--agent-reply-file", "--timeout-ms", "--claude-session"]);
export const BOOL_FLAGS = new Set(["--json", "--no-open", "--reopen", "--with-claude", "--agent", "--help", "-h", "--version"]);

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (VALUE_FLAGS.has(a)) {
      if (i + 1 >= argv.length) throw new CliError("VALIDATION_ERROR", `${a} needs a value`, "Add the value and retry.");
      flags[a] = argv[++i];
    } else if (BOOL_FLAGS.has(a)) {
      flags[a] = true;
    } else if (a.startsWith("--")) {
      throw new CliError("VALIDATION_ERROR", `Unknown flag: ${a}`, "Run `see-plan --help` for usage.");
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

async function agentReplyOf(flags) {
  const inline = flags["--agent-reply"];
  const fromFile = flags["--agent-reply-file"];
  if (inline !== undefined && fromFile !== undefined) {
    throw new CliError("VALIDATION_ERROR", "Use either --agent-reply or --agent-reply-file, not both", "Pass one of them.");
  }
  if (inline !== undefined) return inline;
  if (fromFile === undefined) return undefined;
  try {
    return fromFile === "-" ? await readStdin() : await fs.promises.readFile(fromFile, "utf8");
  } catch (e) {
    throw new CliError("VALIDATION_ERROR", `Cannot read reply file ${fromFile}: ${e.message}`, "Check the path and retry.");
  }
}

// ---------- commands ----------

/** Maps a Markdown plan (or the html generated from one) to its html artifact. */
async function fileContext(file, { regenerate = false } = {}) {
  if (!file) throw new CliError("VALIDATION_ERROR", "A file argument is required", "Pass the plan file path (.html or .md).");
  let source = isMarkdownPath(file) ? file : await generatedSourceFor(file);
  let htmlFile = file;
  if (source) {
    htmlFile = regenerate ? (await ensurePlanHtml(source)).htmlPath : htmlPathFor(source);
  }
  await assertHtmlFile(htmlFile);
  const real = await canonicalFile(htmlFile);
  const out = { real, key: sessionKey(real), display: source ?? file };
  if (source) out.source = await canonicalFile(source);
  return out;
}

function claudeSessionOf(flags) {
  const id = flags["--claude-session"];
  if (id !== undefined && !isClaudeSessionId(id)) {
    throw new CliError("VALIDATION_ERROR", "--claude-session must be a Claude session UUID", "Pass the id Claude reports for this session, or omit the flag.");
  }
  return id;
}

/** Claude Code sets CLAUDECODE=1 and CLAUDE_CODE_SESSION_ID in the shells it runs; the panel shows who is polling. */
export function pollingAgent(claudeSession, env, { agentFlag = false } = {}) {
  if (!claudeSession && env.CLAUDECODE !== "1") return agentFlag ? { agent: "agent" } : {};
  const id = claudeSession ?? (isClaudeSessionId(env.CLAUDE_CODE_SESSION_ID) ? env.CLAUDE_CODE_SESSION_ID : undefined);
  return id ? { agent: "claude", claude_session_id: id } : { agent: "claude" };
}

async function attachClaudeSession(baseUrl, key, id, file) {
  const res = await api(baseUrl, "POST", `/api/${key}/claude-session`, { body: { id }, timeoutMs: 10000 });
  if (res.status !== 200) throw httpError(res, file);
}

async function cmdOpen(file, flags, io) {
  const claudeSession = claudeSessionOf(flags);
  const ctx = await fileContext(file, { regenerate: true });
  file = ctx.display;
  const baseUrl = await ensureServer(io.env);
  const body = { file: ctx.real, reopen: Boolean(flags["--reopen"]) };
  if (ctx.source) body.source_file = ctx.source;
  const res = await api(baseUrl, "POST", "/api/sessions", { body });
  if (res.status !== 200) throw httpError(res, file);
  const { status, url } = res.body;
  if (status === "user-ended") return createUserEndedOutput({ file });
  if (claudeSession) await attachClaudeSession(baseUrl, res.body.key, claudeSession, file); // the session exists only now
  let shown = status;
  const noOpen = flags["--no-open"] || io.env.MY_LAVISH_NO_OPEN === "1";
  if (!noOpen) {
    try {
      await (await import("open")).default(url);
    } catch (e) {
      io.stderr.write(`Could not open a browser: ${e.message}\n`);
      shown = "ready";
    }
  }
  let claudeSessionId;
  if (flags["--with-claude"]) {
    const connected = await api(baseUrl, "POST", `/api/${res.body.key}/connect-claude`, { body: {}, timeoutMs: 15000 });
    if (connected.status !== 200) throw httpError(connected, file);
    claudeSessionId = connected.body.claude_session_id;
  }
  return createOpenOutput({ file, url, status: shown, claudeSessionId, knowsOwnSession: Boolean(claudeSession) || isClaudeSessionId(io.env.CLAUDE_CODE_SESSION_ID) });
}

async function cmdPoll(file, flags, io) {
  const claudeSession = claudeSessionOf(flags);
  const ctx = await fileContext(file, { regenerate: true });
  const { real } = ctx;
  file = ctx.display;
  const reply = await agentReplyOf(flags);
  const body = { file: real, ...pollingAgent(claudeSession, io.env, { agentFlag: Boolean(flags["--agent"]) }) };
  if (reply !== undefined) body.agent_reply = reply;
  if (flags["--timeout-ms"] !== undefined) {
    const n = Number(flags["--timeout-ms"]);
    if (!Number.isFinite(n) || n < 0) {
      throw new CliError("VALIDATION_ERROR", "--timeout-ms must be a non-negative number", "Pass milliseconds, or omit it.");
    }
    body.timeoutMs = n;
  } else if (body.agent) {
    body.timeoutMs = AGENT_POLL_MS; // the server caps agent polls too, for older CLIs
  }
  const baseUrl = await ensureServer(io.env);
  if (claudeSession) await attachClaudeSession(baseUrl, ctx.key, claudeSession, file);
  io.stderr.write(`Waiting for feedback on ${file} (stays silent until the user sends)…\n`);

  let onSigint;
  try {
    const res = await new Promise((resolve, reject) => {
      api(baseUrl, "POST", "/api/poll", {
        body,
        signalHandle: (req) => {
          onSigint = () => {
            io.stderr.write("Poll interrupted. Feedback stays queued; re-run the same poll.\n");
            req.destroy();
            reject(new Interrupted());
          };
          process.once("SIGINT", onSigint);
        },
      }).then(resolve, reject);
    });
    if (res.status !== 200) throw httpError(res, file);
    return createPollOutput({ file, response: res.body });
  } finally {
    if (onSigint) process.removeListener("SIGINT", onSigint);
  }
}

async function cmdReply(file, flags, io) {
  const ctx = await fileContext(file);
  const { key } = ctx;
  file = ctx.display;
  const text = await agentReplyOf(flags);
  if (text === undefined) {
    throw new CliError("VALIDATION_ERROR", "reply needs --agent-reply or --agent-reply-file", 'Run `see-plan reply <file> --agent-reply "<text>"`.');
  }
  const baseUrl = await ensureServer(io.env);
  const res = await api(baseUrl, "POST", `/api/${key}/agent-reply`, { body: { text }, timeoutMs: 10000 });
  if (res.status !== 200) throw httpError(res, file);
  return { ok: true, next_step: `Reply posted. Run \`${POLL_CMD(file)}\` to keep listening for feedback.` };
}

async function cmdEnd(file, io) {
  const ctx = await fileContext(file);
  const { key } = ctx;
  file = ctx.display;
  const baseUrl = await ensureServer(io.env);
  const res = await api(baseUrl, "POST", `/api/${key}/end`, { body: {}, timeoutMs: 10000 });
  if (res.status !== 200) throw httpError(res, file);
  return {
    session: { file, status: "ended", ended_by: res.body.ended_by },
    next_step: "The session is ended. Give any final summary in chat and do not poll.",
  };
}

async function cmdStop(io) {
  const { port } = configOf(io.env);
  const baseUrl = `http://127.0.0.1:${port}`;
  const probe = await probeHealth(baseUrl);
  if (!probe.up) return { ok: true, stopped: false, next_step: "Nothing was running. No action needed." };
  if (probe.health?.app !== APP) {
    throw new CliError("PORT_IN_USE", `Port ${port} is used by another application`, "Nothing was stopped. Set MY_LAVISH_PORT if you meant a different server.");
  }
  const res = await api(baseUrl, "POST", "/shutdown", { body: {}, timeoutMs: 10000 });
  if (res.status !== 200) throw httpError(res, "");
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    if (!(await probeHealth(baseUrl)).up) break;
  }
  return { ok: true, stopped: true, next_step: "Server stopped. Any command that needs it starts it again." };
}

async function cmdServer(io) {
  const { port, stateDir, idleTimeoutMs } = configOf(io.env);
  await fs.promises.mkdir(stateDir, { recursive: true });
  const version = JSON.parse(await fs.promises.readFile(PACKAGE_PATH, "utf8")).version;
  const server = createServer({
    store: new SessionStore(stateDir),
    stateDir,
    port,
    idleTimeoutMs,
    exitOnIdle: true,
    version,
    log: (m) => io.stderr.write(`${m}\n`),
  });
  const { baseUrl } = await server.listen();
  io.stderr.write(`listening on ${baseUrl}\n`);
  await new Promise((resolve) => server.events.once("closed", resolve));
  return null;
}

/** Starts the server if needed and opens the Claude log page; returns its url and whether a browser opened. */
async function openLogsPage(flags, io) {
  const url = `${await ensureServer(io.env)}/claude`;
  if (flags["--no-open"] || io.env.MY_LAVISH_NO_OPEN === "1") return { url, opened: false };
  try {
    await (await import("open")).default(url);
    return { url, opened: true };
  } catch (e) {
    io.stderr.write(`Could not open a browser: ${e.message}
`);
    return { url, opened: false };
  }
}

async function cmdLogs(flags, io) {
  const { url, opened } = await openLogsPage(flags, io);
  return {
    logs: { url, status: opened ? "opened" : "ready" },
    next_step: opened
      ? "The browser shows the newest Claude session's log; clicking an entry adds it to ~/claude-errors/error-log.json."
      : `Open ${url} to see the newest Claude session's log.`,
  };
}

async function cmdHome(flags, io) {
  const { stateDir } = configOf(io.env);
  let sessions = [];
  try {
    sessions = await new SessionStore(stateDir).listSessions();
  } catch {}
  // A person at a terminal (agents run without a TTY) also gets the Claude log page.
  let logsUrl;
  if (io.stdout.isTTY) {
    try {
      logsUrl = (await openLogsPage(flags, io)).url;
    } catch (e) {
      io.stderr.write(`Could not open the Claude log page: ${e.message}
`);
    }
  }
  return createHomeOutput({ sessions, logsUrl });
}

function cmdPlaybook(id) {
  if (!id) {
    return {
      playbooks: PLAYBOOKS.map(({ id: pid, use_when }) => ({ id: pid, use_when })),
      next_step: "Open every playbook whose use_when matches before writing HTML: see-plan playbook <id>",
    };
  }
  const pb = PLAYBOOKS.find((p) => p.id === id);
  if (!pb) {
    throw new CliError("NOT_FOUND", `No playbook "${id}"`, `Run \`see-plan playbook\` to list ids: ${PLAYBOOKS.map((p) => p.id).join(", ")}.`);
  }
  return {
    playbook: { id: pb.id, use_when: pb.use_when, guidance: pb.guidance },
    next_step: "Apply this guidance, then write the HTML and run `see-plan <file.html>`.",
  };
}

// ---------- entry ----------

export async function run(argv, io = { stdout: process.stdout, stderr: process.stderr, env: process.env }) {
  let json = argv.includes("--json");
  const emit = (obj) => io.stdout.write((json ? JSON.stringify(obj, null, 2) : toToon(obj)) + "\n");
  try {
    const { flags, positional } = parseArgs(argv);
    json = Boolean(flags["--json"]);
    if (flags["--version"]) {
      io.stdout.write(JSON.parse(await fs.promises.readFile(PACKAGE_PATH, "utf8")).version + "\n");
      return 0;
    }
    const [first, second] = positional;
    let result;
    if (flags["--help"] || flags["-h"] || first === undefined) {
      result = flags["--help"] || flags["-h"] ? { usage: HOME_USAGE, next_step: "Run one of the commands above." } : await cmdHome(flags, io);
    } else if (first === "open") result = await cmdOpen(second, flags, io);
    else if (/\.(html?|md|markdown)$/i.test(first)) result = await cmdOpen(first, flags, io);
    else if (first === "poll") result = await cmdPoll(second, flags, io);
    else if (first === "reply") result = await cmdReply(second, flags, io);
    else if (first === "end") result = await cmdEnd(second, io);
    else if (first === "stop") result = await cmdStop(io);
    else if (first === "logs") result = await cmdLogs(flags, io);
    else if (first === "server") result = await cmdServer(io);
    else if (first === "design") result = { design: DESIGN_TEXT, next_step: "Apply these rules, then check `see-plan playbook` for page recipes." };
    else if (first === "playbook") result = cmdPlaybook(second);
    else throw new CliError("VALIDATION_ERROR", `Unknown command: ${first}`, "Run `see-plan --help` for usage.");
    if (result) emit(result);
    return 0;
  } catch (e) {
    if (e instanceof Interrupted) return 130;
    const code = e instanceof CliError || e.code === "VALIDATION_ERROR" ? e.code : "INTERNAL";
    emit({
      error: { code, message: e.message },
      next_step: e.nextStep ?? (code === "VALIDATION_ERROR" ? "Fix the input and retry." : "Retry; if it keeps failing, check server.log in the state dir."),
    });
    return 1;
  }
}
