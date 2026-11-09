import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import { WebSocketServer } from "ws";
import { watchArtifact } from "./artifact-watcher.js";
import { assertHtmlFile, canonicalFile, resolveArtifactAsset } from "./artifact-path.js";
import { injectSdk } from "./html-transform.js";
import { createChromeHtml } from "./chrome-page.js";
import { createLogsHtml } from "./logs-page.js";
import { ErrorLogError } from "./error-log.js";
import { LocalErrorStore } from "./error-store.js";
import { createErrorsHtml } from "./errors-page.js";
import { isSeverity, needsReason, SEVERITIES } from "./severity.js";
import { serializeChat } from "./markdown.js";
import { sessionKey, StoreError } from "./session-store.js";
import { ensurePlanHtml, htmlPathFor, isMarkdownPath, renderPlanHtml } from "./plan-markdown.js";
import { CATEGORY_TITLES, SESSION_FEEDBACK_CATEGORIES, STAGES, STAGE_TITLES, effectiveStage, inferStageFromText, isStage, nextStage, stageInstructions } from "./stages.js";
import { listOutputRevisions, listRevisions, readOutputRevision, readRevision, saveOutputRevision, saveRevision } from "./revisions.js";
import { getOutput, imageType, kindOf, maxBytesFor, outputsOf, placeholderPage, promptOutput, renderOutputPage, withMermaid } from "./outputs.js";
import { appendFeedback } from "./feedback-log.js";
import {
  advanceWorkflow, createWorkflow, ensureStageFile, getWorkflow, isFeatureName, listWorkflows, reopenStage,
  requirementsFile, stageFile, updateStage,
} from "./workflow-store.js";
import { createHomeHtml } from "./home-page.js";
import { resolvePaths } from "./paths.js";
import { findProjectRoot, isPlanFileName, listSuperpowersPlans } from "./project.js";
import { getProject, isProjectKey, listProjects, registerProject } from "./project-store.js";
import { CONTENT_TYPES, PUBLIC_ASSETS, readAsset } from "./assets.js";
import { createClaudeSessionLister, findLastPromptAt, findTranscript, readTranscript } from "./claude-log.js";
import { buildPrompt, claudeStatus as realClaudeStatus, findRepoRoot, isClaudeSessionId, launchClaude as realLaunchClaude } from "./claude-launcher.js";
import { bearerOf, capFor, cookieNameFor, cookieValueFor, createNonceStore, createToken, parseCookies, safeEqual, safeNext } from "./auth.js";
import { scheduleIdleWarnings } from "./console-log.js";
import { detectEnvironment, parseEnvHeader } from "./environment.js";

export { PUBLIC_ASSETS };
const ALLOWED_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);
const PING_INTERVAL_MS = 30000;
const CONNECT_COOLDOWN_MS = 60000;
export const AGENT_POLL_MS = 110000; // under Claude Code's default 120 s Bash timeout
const PRESENCE_GRACE_MS = 20000; // a re-poll within this window is invisible to the user
const LAUNCH_ERROR_STATUS = { UNSUPPORTED_PLATFORM: 501, CLAUDE_NOT_FOUND: 424, LAUNCHER_OFF: 409 };
const STORE_ERROR_STATUS = { MISSING: 404, ENDED: 409, NOT_ENDED: 409, UNSENT_NOTES: 409, NOT_CURRENT: 409, OUTPUT_IN_OTHER_SESSION: 409 };
const MAX_FEEDBACK_TEXT = 4000;
const LOG_ROLES = new Set(["user", "assistant"]);
const LOG_KINDS = new Set(["text", "tool_use", "tool_result"]);
const MAX_LOG_TEXT = 20000;
const MAX_REASON = 2000;
const SESSION_KEY = /^[0-9a-f]{16}$/; // sessionKey(): the first 16 hex digits of a sha256
const PAGE_LOG_BYTES = 1024 * 1024; // the log page's first window; it doubles up to PAGE_MAX_BYTES...
const PAGE_MAX_BYTES = 16 * 1024 * 1024;
const PAGE_MIN_ENTRIES = 200; // ...until it holds this many entries (screenshots make some lines huge)
const ERROR_CONTEXTS = ["session", "plan"];
const SEVERITY_FILTERS = [...SEVERITIES, "unrated"];
const ERROR_PREVIEW_CHARS = 500;
const MAX_SIMILAR_QUERY = 4000;
const ERROR_LOG_STATUS = { MISSING: 404, ALREADY_RATED: 409, VALIDATION_ERROR: 400, ERROR_LOG_UNREADABLE: 409 };

/** limit/offset: rounded down, clamped to [min, max]; the default when missing or not a number. */
function intParam(raw, fallback, min, max) {
  if (typeof raw !== "string" || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : fallback;
}

/** Validates an optional enum query value: undefined when absent, null when invalid. */
function enumParam(raw, allowed) {
  if (raw === undefined || raw === "") return undefined;
  return typeof raw === "string" && allowed.includes(raw) ? raw : null;
}

/** Plans tab status (archived wins). */
export function planStatus(s) {
  if (s.archived) return "Archived";
  if (s.status === "open") return "Open";
  if (s.status === "feedback") return "Needs changes";
  if (s.status === "ended") return s.ended_by === "approved" ? "Approved" : "Ended";
  return "Open";
}

function hostnameOf(hostHeader) {
  if (!hostHeader) return "";
  if (hostHeader.startsWith("[")) return hostHeader.slice(0, hostHeader.indexOf("]") + 1).toLowerCase();
  return hostHeader.split(":")[0].toLowerCase();
}

function originOf(value) {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/** True only when an Origin header is present and equals http://<Host>. */
export function requireSameOrigin(req) {
  const origin = req.headers.origin;
  if (typeof origin !== "string") return false;
  return origin === `http://${req.headers.host}` || (req.seePlanForwarded === true && origin === `https://${req.headers.host}`);
}

function errorBody(code, message) {
  return { error: { code, ...(message ? { message } : {}) } };
}

function sendStoreError(res, e) {
  if (!(e instanceof StoreError)) throw e;
  res.status(STORE_ERROR_STATUS[e.code] ?? 400).json(errorBody(e.code, e.message));
}

/** True for browser requests made from another site (header-less CLI requests are not). */
function isCrossSite(req) {
  const site = req.headers["sec-fetch-site"];
  if (site !== undefined && site !== "same-origin" && site !== "none") return true;
  const source = req.headers.origin ?? req.headers.referer;
  if (source === undefined) return false;
  const o = originOf(source);
  return o !== `http://${req.headers.host}` && !(req.seePlanForwarded === true && o === `https://${req.headers.host}`);
}

const MAX_TIMER_MS = 2147483647;
const isText = (v) => typeof v === "string" && v.trim() !== "";

function parseTimeout(value) {
  if (value === undefined || value === null || value === "") return 0;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.min(n, MAX_TIMER_MS) : null;
}

export function createServer({
  store,
  stateDir,
  port = 4388,
  host = "127.0.0.1",
  idleTimeoutMs = 1800000,
  exitOnIdle = false,
  version,
  log = () => {},
  launchClaude = realLaunchClaude,
  claudeStatus = realClaudeStatus,
  claudeDir = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"),
  errorLogFile = resolvePaths().errorLogFile,
  errorSearch = false, // the USE_ERROR_SEARCH feature flag: /api/errors/similar and /api/errors/store answer 404 while off
  errorStore = null, // src/error-store.js: Pinecone when USE_PINECONE=true and a key is set (cmdServer decides); else the file
  logDir = null, // shown in the console banner; server.log itself is opened by whoever starts the server
  agentPollMs = AGENT_POLL_MS,
  presenceGraceMs = PRESENCE_GRACE_MS,
  connectCooldownMs = CONNECT_COOLDOWN_MS,
  claudeSessionTtlMs = 30000,
  projectHome = os.homedir(), // D9: never a project root (tests point it elsewhere)
  token = createToken(), // T2: every API call, page and WebSocket needs it (bearer or cookie); there is no off switch
  allowedHosts = [], // H5: extra exact Host names (port forwarders); only ever added on top of the token check
  nonceTtlMs = 60000,
  launcherConfig = {}, // H3: { launcher, terminal } from MY_LAVISH_LAUNCHER / MY_LAVISH_TERMINAL / config.json
  idleWarnings = false, // S4: log the idle countdown at 5 min and 1 min (the server window shows it)
}) {
  let cancelIdleWarnings = null;
  const errors = errorStore ?? new LocalErrorStore(errorLogFile);
  const errorLogLabel = errors.label; // what the pages and the API name as "the error log"
  const clientEnvs = new Map(); // key -> the newest caller's environment (H2), in memory only
  /** H2: keeps the newest valid X-See-Plan-Env per session (size-capped and schema-checked; never in state.json). */
  function rememberEnv(key, req) {
    const env = parseEnvHeader(req.headers["x-see-plan-env"]);
    if (env) clientEnvs.set(key, env);
  }
  /** The environment Connect Claude should use: the session's newest caller, else the server's own. */
  const environmentFor = (key) => clientEnvs.get(key) ?? detectEnvironment();
  // Log lines name a session by its file name and count notes; note and transcript text are never logged (S4).
  const titleOf = (s) => path.basename(s?.source_file ?? s?.file ?? "session");
  const claudeSessions = createClaudeSessionLister({ ttlMs: claudeSessionTtlMs });
  const app = express();
  const events = new EventEmitter();
  const wss = new WebSocketServer({ noServer: true });
  const sockets = new Map(); // key -> Set<WebSocket>
  const watchers = new Map(); // key -> artifact watcher
  const activePolls = new Map(); // key -> poll state
  const background = new Set(); // promises close() must wait for
  let httpServer = null;
  let baseUrl = null;
  let closing = null;
  let pingTimer = null;
  let idleTimer = null;
  const claudeLinks = new Map(); // key -> { claudeSessionId, transcriptPath }: keeps state.json off the log hot path
  const agents = new Map(); // key -> { agent, sessionId, working }: the last poller, for the panel's status line
  const pendingLaunch = new Map(); // key -> launched-at ms: one launch at a time per session
  const graces = new Map(); // key -> { until, timer }: a poll just ended; the user still sees "connected"
  const lastPresence = new Map(); // key -> JSON of the last visible presence broadcast
  const lastPollAt = new Map(); // key -> ISO time of the last poll that listened
  const transcripts = new Map(); // Claude session id -> transcript path, for the log page
  const homeSockets = new Set(); // the dashboard's /events/home sockets
  let homeTimer = null;
  const feedbackFile = path.join(stateDir ?? os.tmpdir(), "feedback.jsonl");

  function track(promise) {
    background.add(promise);
    promise.finally(() => background.delete(promise)).catch(() => {});
    return promise;
  }

  function broadcast(key, message) {
    if (message.type !== "chat") notifyHome();
    const set = sockets.get(key);
    if (!set) return;
    const data = JSON.stringify(message);
    for (const ws of set) if (ws.readyState === ws.OPEN) ws.send(data);
  }

  async function broadcastChat(key) {
    const session = await store.getSession(key);
    if (session) broadcast(key, { type: "chat", chat: serializeChat(session.chat) });
    return session;
  }

  function inGrace(key) {
    const g = graces.get(key);
    return Boolean(g && Date.now() < g.until);
  }

  function clearGrace(key) {
    const g = graces.get(key);
    if (g) clearTimeout(g.timer);
    graces.delete(key);
  }

  // `working`: the last poll took feedback and no poll has listened since.
  // `cycling`: no poll listens right now, but one ended moments ago (a routine reconnect); the UI shows it as connected.
  function presence(key) {
    const a = agents.get(key);
    const live = Boolean(activePolls.get(key)?.listening);
    const cycling = !live && !a?.working && inGrace(key);
    return {
      type: "presence",
      listening: live || cycling,
      agent: a?.agent ?? null,
      session_id: a?.sessionId ?? null,
      working: Boolean(a?.working),
      cycling,
      last_poll_at: lastPollAt.get(key) ?? null,
    };
  }

  /** Broadcasts presence only when what the user sees changed (cycling and last_poll_at are not visible). */
  function broadcastPresence(key, { force = false } = {}) {
    const p = presence(key);
    const visible = JSON.stringify([p.listening, p.agent, p.session_id, p.working]);
    if (!force && lastPresence.get(key) === visible) return;
    lastPresence.set(key, visible);
    broadcast(key, p);
  }

  function startGrace(key) {
    clearGrace(key);
    if (!(presenceGraceMs > 0) || closing) return false;
    const timer = setTimeout(() => {
      graces.delete(key);
      if (!activePolls.get(key)?.listening) broadcastPresence(key);
    }, presenceGraceMs);
    timer.unref();
    graces.set(key, { until: Date.now() + presenceGraceMs, timer });
    return true;
  }

  function sessionSummary(s) {
    const live = Boolean(activePolls.get(s.key)?.listening) || inGrace(s.key);
    return {
      key: s.key,
      file: s.source_file ?? s.file,
      url: s.url,
      stage: s.stage ?? null,
      stage_source: s.stage_source ?? null,
      status: s.status,
      ended_by: s.ended_by ?? null,
      workflow_id: s.workflow_id ?? null,
      updated_at: s.updated_at,
      agent: live ? (agents.get(s.key)?.agent ?? "agent") : agents.get(s.key)?.working ? "working" : null,
    };
  }

  // D3: which review session (if any) a Claude session belongs to. Built in one store transaction and
  // cached by state.json's mtime and size, plus the store's write count (two quick writes can share an
  // mtime on Windows). The most recently updated review session wins a shared id.
  let lookupCache = null; // { stamp, value: Promise<{ byClaude, sessions, byKey }> }
  const stateFile = path.join(stateDir ?? os.tmpdir(), "state.json");
  async function classificationLookup() {
    const st = await fs.promises.stat(stateFile).catch(() => null);
    const stamp = `${store.writeCount ?? ""}:${st ? `${st.mtimeMs}:${st.size}` : "none"}`;
    if (lookupCache?.stamp === stamp) return lookupCache.value;
    const value = store.listSessions({ includeArchived: true }).then((sessions) => {
      const byClaude = new Map();
      const newest = new Map();
      for (const s of sessions) {
        const id = s.claude_session_id;
        if (!isClaudeSessionId(id)) continue;
        const prev = newest.get(id);
        if (prev && String(prev.updated_at ?? "") >= String(s.updated_at ?? "")) continue;
        newest.set(id, s);
        const stage = effectiveStage(s);
        byClaude.set(id, { context: stage === "plan" ? "plan" : "session", review_key: s.key, stage });
      }
      return { byClaude, sessions, byKey: new Map(sessions.map((s) => [s.key, s])) };
    });
    lookupCache = { stamp, value };
    value.catch(() => {
      if (lookupCache?.value === value) lookupCache = null;
    });
    return value;
  }

  async function errorSummary(lookup) {
    try {
      return await errors.summarize(lookup.byClaude);
    } catch (e) {
      if (!(e instanceof ErrorLogError)) throw e;
      return { counts: null, bySession: new Map(), byReview: new Map(), unreadable: e.message };
    }
  }

  function sendErrorLogError(res, e) {
    if (!(e instanceof ErrorLogError)) throw e;
    res.status(ERROR_LOG_STATUS[e.code] ?? 409).json(errorBody(e.code, e.message));
  }

  async function homeSnapshot() {
    const sessions = (await store.listSessions()).map(sessionSummary);
    return { type: "sessions", sessions, workflows: await listWorkflows(store) };
  }

  // Debounced: one dashboard update per burst of changes.
  function notifyHome() {
    if (!homeSockets.size || homeTimer || closing) return;
    homeTimer = setTimeout(() => {
      homeTimer = null;
      track(homeSnapshot().then((snap) => {
        const data = JSON.stringify(snap);
        for (const ws of homeSockets) if (ws.readyState === ws.OPEN) ws.send(data);
      }, (e) => log(`home update failed: ${e?.message ?? e}`)));
    }, 100);
    homeTimer.unref();
  }

  async function linkClaudeSession(key, id) {
    await store.setClaudeSession(key, id);
    claudeLinks.set(key, { claudeSessionId: id, transcriptPath: null });
    broadcast(key, { type: "claude-session", id });
  }

  // Idle exit: counts down only while nothing (no WebSocket, no poll) is connected.
  function updateIdle() {
    if (closing || !httpServer || !(idleTimeoutMs > 0)) return;
    let connected = activePolls.size + homeSockets.size;
    for (const set of sockets.values()) connected += set.size;
    if (connected > 0) {
      clearIdle();
    } else if (!idleTimer) {
      idleTimer = setTimeout(() => {
        log(`idle for ${idleTimeoutMs} ms, shutting down`);
        shutdown("idle"); // the server process exits once "closed" is emitted (cmdServer)
      }, idleTimeoutMs);
      idleTimer.unref();
      if (idleWarnings) cancelIdleWarnings = scheduleIdleWarnings(idleTimeoutMs, log);
    }
  }

  function clearIdle() {
    clearTimeout(idleTimer);
    idleTimer = null;
    cancelIdleWarnings?.();
    cancelIdleWarnings = null;
  }

  // The log page polls over plain HTTP: each read restarts the idle countdown.
  function touchIdle() {
    clearIdle();
    updateIdle();
  }

  // One watcher per session; resolves once the watcher is ready.
  function watchSession(session) {
    if (closing || watchers.has(session.key)) return Promise.resolve();
    const { key } = session;
    const watcher = watchArtifact(session.file, {
      onChange: () => {
        if (closing) return;
        track(
          store.bumpRevision(key).then(
            async (revision) => {
              const current = await store.getSession(key);
              await saveRevision(stateDir, key, revision, { file: session.file, sourceFile: current?.source_file })
                .catch((e) => log(`revision save failed for ${key}: ${e?.message ?? e}`));
              broadcast(key, { type: "reload", revision });
            },
            (e) => log(`revision bump failed for ${key}: ${e?.message ?? e}`),
          ),
        );
      },
      onError: (e) => log(`watcher error for ${key}: ${e?.message ?? e}`),
    });
    watchers.set(key, watcher);
    const ready = [watcher.ready, ...(session.outputs ?? []).map((o) => watchOutput(key, o))];
    // A Markdown plan: editing the .md regenerates the html, which the watcher above then reloads.
    if (session.source_file && htmlPathFor(session.source_file) === session.file) {
      const md = watchArtifact(session.source_file, {
        onChange: () => {
          if (closing) return;
          track(ensurePlanHtml(session.source_file).catch((e) => log(`md regenerate failed for ${key}: ${e?.message ?? e}`)));
        },
        onError: (e) => log(`md watcher error for ${key}: ${e?.message ?? e}`),
      });
      watchers.set(`${key}:md`, md);
      ready.push(md.ready);
    }
    return Promise.all(ready);
  }

  // M5: one watcher per added output. A Markdown output regenerates its html first.
  function watchOutput(key, output) {
    const name = `${key}:o:${output.id}`;
    if (closing || watchers.has(name)) return Promise.resolve();
    const watcher = watchArtifact(output.file, {
      onChange: () => {
        if (closing) return;
        track((async () => {
          if (output.kind === "markdown") await ensurePlanHtml(output.file);
          const revision = await store.bumpOutputRevision(key, output.id);
          await saveOutputRevision(stateDir, key, output.id, revision, output.file);
          broadcast(key, { type: "reload", output: output.id, revision });
        })().catch((e) => log(`output update failed for ${name}: ${e?.message ?? e}`)));
      },
      onError: (e) => log(`watcher error for ${name}: ${e?.message ?? e}`),
    });
    watchers.set(name, watcher);
    return watcher.ready;
  }

  const outputsView = (session) => outputsOf(session).map((o) => ({ id: o.id, file: o.file, kind: o.kind, revision: o.revision ?? 0 }));

  app.disable("x-powered-by");

  // H5: hosts a port forwarder uses (Codespaces, VS Code). Exact names only; the token check below always runs.
  const extraHosts = new Set(allowedHosts.map((h) => String(h).trim().toLowerCase()).filter(Boolean));
  const hostAllowed = (hostHeader) => {
    const name = hostnameOf(hostHeader);
    return ALLOWED_HOSTNAMES.has(name) || extraHosts.has(name);
  };
  const sameOriginSource = (req, source) => {
    const o = originOf(source);
    return o === `http://${req.headers.host}` || (extraHosts.has(hostnameOf(req.headers.host)) && o === `https://${req.headers.host}`);
  };

  // ---- T5: the token (bearer for the CLI, cookie for the browser) ----
  const nonces = createNonceStore({ ttlMs: nonceTtlMs });
  const cookieValue = cookieValueFor(token);
  let boundPort = port;
  const cookieName = () => cookieNameFor(boundPort);
  const hasBearer = (req) => safeEqual(bearerOf(req.headers.authorization) ?? "", token);
  const hasCookie = (req) => safeEqual(parseCookies(req.headers.cookie).get(cookieName()) ?? "", cookieValue);
  const authed = (req) => hasBearer(req) || hasCookie(req);
  const publicPaths = new Set(PUBLIC_ASSETS.map((n) => `/${n}`));
  /** Open without a token: health, the login link, static files, and artifact frames (they carry a capability, T6). */
  function authExempt(req) {
    if (req.method !== "GET" && req.method !== "HEAD") return false;
    return req.path === "/health" || req.path === "/auth" || publicPaths.has(req.path) || req.path.startsWith("/artifact/");
  }
  const AUTH_MESSAGE = "This see-plan server needs its token. A 3.x see-plan cannot talk to it: upgrade see-plan. In a browser, run `see-plan url` in a terminal to get a sign-in link.";

  function unauthorizedPage() {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sign in to see-plan</title>
<style>:root{color-scheme:light dark}body{font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;max-width:36rem;margin:15vh auto;padding:0 16px}code{background:rgba(127,127,127,.15);padding:2px 6px;border-radius:4px}</style></head>
<body><h1>Sign in to see-plan</h1><p>Run <code>see-plan url</code> in a terminal to get a sign-in link, then open it here.</p>
<p>A link works once and expires after a minute. Opening a review with <code>see-plan &lt;file&gt;</code> signs you in too.</p></body></html>`;
  }

  // Host allowlist: blocks DNS rebinding.
  app.use((req, res, next) => {
    if (!hostAllowed(req.headers.host)) {
      return res.status(403).json(errorBody("FORBIDDEN_HOST", "Host not allowed"));
    }
    if (extraHosts.has(hostnameOf(req.headers.host))) req.seePlanForwarded = true; // X-Forwarded-Proto is trusted only here
    next();
  });

  // Token check, right after the Host allowlist. The Origin checks below stay as defence in depth.
  app.use((req, res, next) => {
    if (authExempt(req) || authed(req)) return next();
    const page = req.method === "GET" && !req.path.startsWith("/api/");
    if (page) {
      res.set("Cache-Control", "no-store");
      return res.status(401).type("html").send(unauthorizedPage());
    }
    res.status(401).json(errorBody("AUTH_REQUIRED", AUTH_MESSAGE));
  });

  // Origin guard: blocks cross-site writes. Header-less (CLI) requests pass.
  app.use((req, res, next) => {
    if (req.method === "GET" || req.method === "HEAD") return next();
    const source = req.headers.origin ?? req.headers.referer;
    if (source !== undefined && !sameOriginSource(req, source)) {
      return res.status(403).json(errorBody("FORBIDDEN_ORIGIN", "Cross-origin request refused"));
    }
    next();
  });

  app.use(express.json({ limit: "5mb" }));

  app.get("/health", (req, res) => {
    res.json({ ok: true, app: "my-lavish-axi", version, auth: "token" });
  });

  // T4: the CLI (bearer only, not a cookie) asks for a single-use, 60 s login nonce...
  app.post("/api/auth/nonce", (req, res) => {
    if (!hasBearer(req)) return res.status(401).json(errorBody("AUTH_REQUIRED", "Sign-in links are made by the see-plan CLI"));
    res.json({ nonce: nonces.issue(), expires_in_ms: nonceTtlMs });
  });

  // ...and the browser trades it for the cookie, then lands on `next` (a same-origin path only).
  app.get("/auth", (req, res) => {
    const next = safeNext(req.query.next);
    if (next === null) return res.status(400).json(errorBody("VALIDATION_ERROR", "next must be a same-origin path"));
    res.set("Cache-Control", "no-store");
    res.set("Referrer-Policy", "no-referrer");
    if (!nonces.consume(req.query.t)) return res.status(401).type("html").send(unauthorizedPage());
    const https = req.seePlanForwarded === true && String(req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim() === "https";
    res.set("Set-Cookie", `${cookieName()}=${cookieValue}; HttpOnly; SameSite=Strict; Path=/${https ? "; Secure" : ""}`);
    res.redirect(303, next);
  });

  app.post("/shutdown", (req, res) => {
    res.json({ ok: true });
    res.on("finish", () => setImmediate(() => shutdown("see-plan stop").catch(() => {})));
  });

  app.post("/api/sessions", async (req, res, next) => {
    try {
      const { file, reopen, source_file: sourceFile, stage } = req.body ?? {};
      if (stage !== undefined && !isStage(stage)) {
        return res.status(400).json(errorBody("VALIDATION_ERROR", `stage must be one of ${STAGES.join(", ")}`));
      }
      if (typeof file !== "string" || !file) {
        return res.status(400).json(errorBody("VALIDATION_ERROR", "file is required"));
      }
      let real;
      try {
        await assertHtmlFile(file);
        real = await canonicalFile(file);
      } catch (e) {
        if (e.code === "VALIDATION_ERROR") {
          return res.status(400).json(errorBody("VALIDATION_ERROR", e.message));
        }
        throw e;
      }
      let source;
      if (sourceFile !== undefined) {
        try {
          if (typeof sourceFile !== "string" || !isMarkdownPath(sourceFile)) throw new StoreError("VALIDATION_ERROR", "source_file must be a .md or .markdown path");
          source = await canonicalFile(sourceFile);
        } catch (e) {
          return res.status(400).json(errorBody("VALIDATION_ERROR", e instanceof StoreError ? e.message : "source_file not found"));
        }
      }
      const holder = await store.findOutputOwner(source ?? real);
      if (holder && holder.file !== real) {
        return res.status(409).json(errorBody("OUTPUT_IN_OTHER_SESSION", `${source ?? real} is already an output of another review. Run see-plan poll on it to join that review.`));
      }
      let result;
      try {
        result = await openReviewSession(real, { reopen: Boolean(reopen), source_file: source, stage });
      } catch (e) {
        return sendStoreError(res, e);
      }
      const { status, session } = result;
      rememberEnv(session.key, req);
      res.json({ status, key: session.key, url: session.url, stage: session.stage ?? null, stage_source: session.stage_source ?? null, outputs: outputsView(session) });
    } catch (e) {
      next(e);
    }
  });

  /** Creates or resumes the review session for a canonical .html file, as `see-plan <file>` does. */
  async function openReviewSession(real, { reopen = false, source_file, stage } = {}) {
    const result = await store.upsertSession(real, baseUrl, { reopen, source_file, stage });
    const { status, session } = result;
    if (status === "opened") {
      await saveRevision(stateDir, session.key, session.revision, { file: session.file, sourceFile: session.source_file }).catch(() => {});
    }
    await watchSession(session);
    notifyHome();
    if (status !== "user-ended") log(`session ${status}: ${titleOf(session)}`);
    return result;
  }

  // ---- the /errors page: error records, plans, Claude sessions (registered before /api/:key/*) ----

  function refusedCrossSite(req, res) {
    if (!isCrossSite(req)) return false;
    res.status(403).json(errorBody("FORBIDDEN_ORIGIN", "Cross-origin request refused"));
    return true;
  }

  /** { claude_session_id, uuid, part } from a query or body, or null when malformed. */
  function recordRef(src) {
    const id = src?.claude_session_id;
    const uuid = src?.uuid;
    const part = typeof src?.part === "string" && /^\d{1,3}$/.test(src.part) ? Number(src.part) : src?.part;
    if (!isClaudeSessionId(id) || !isText(uuid) || uuid.length > 100 || !Number.isInteger(part) || part < 0 || part >= 1000) return null;
    return { claude_session_id: id, uuid, part };
  }

  async function titlesFor(ids) {
    const titles = new Map();
    await Promise.all([...new Set(ids)].map(async (id) => {
      titles.set(id, await claudeSessions.titleOf({ claudeDir, id }).catch(() => null));
    }));
    return titles;
  }

  function errorItem(r, lookup, titles, { full = false } = {}) {
    const text = String(r.text ?? "");
    const truncated = !full && text.length > ERROR_PREVIEW_CHARS;
    const review = r.review_key ? lookup.byKey.get(r.review_key) : null;
    return {
      claude_session_id: r.claude_session_id,
      claude_title: titles.get(r.claude_session_id) ?? null,
      uuid: r.uuid,
      part: Number(r.part) || 0,
      context: r.context,
      review_key: r.review_key ?? null,
      file: review ? (review.source_file ?? review.file) : null,
      stage: r.stage ?? null,
      role: r.role ?? null,
      kind: r.kind ?? null,
      at: r.at ?? null,
      text: truncated ? text.slice(0, ERROR_PREVIEW_CHARS) : text,
      truncated,
      reason: r.reason,
      severity: r.severity,
      reported_at: r.reported_at ?? null,
      ...(r.rated_at ? { rated_at: r.rated_at } : {}),
    };
  }

  app.get("/api/errors", async (req, res, next) => {
    try {
      if (refusedCrossSite(req, res)) return;
      const context = enumParam(req.query.context, ERROR_CONTEXTS);
      const severity = enumParam(req.query.severity, SEVERITY_FILTERS);
      if (context === null) return res.status(400).json(errorBody("VALIDATION_ERROR", `context must be one of ${ERROR_CONTEXTS.join(", ")}`));
      if (severity === null) return res.status(400).json(errorBody("VALIDATION_ERROR", `severity must be one of ${SEVERITY_FILTERS.join(", ")}`));
      const limit = intParam(req.query.limit, 50, 1, 200);
      const offset = intParam(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
      touchIdle();
      const lookup = await classificationLookup();
      let page;
      try {
        page = await errors.list({ context, severity, limit, offset }, lookup.byClaude);
      } catch (e) {
        return sendErrorLogError(res, e);
      }
      const titles = await titlesFor(page.items.map((r) => r.claude_session_id));
      res.json({ items: page.items.map((r) => errorItem(r, lookup, titles)), total: page.total, next_offset: page.next_offset });
    } catch (e) {
      next(e);
    }
  });

  app.get("/api/errors/record", async (req, res, next) => {
    try {
      if (refusedCrossSite(req, res)) return;
      const ref = recordRef(req.query);
      if (!ref) return res.status(400).json(errorBody("VALIDATION_ERROR", "claude_session_id, uuid and part are required"));
      const lookup = await classificationLookup();
      let record;
      try {
        record = await errors.get(ref, lookup.byClaude);
      } catch (e) {
        return sendErrorLogError(res, e);
      }
      if (!record) return res.status(404).json(errorBody("MISSING", "No such error record"));
      const titles = await titlesFor([record.claude_session_id]);
      res.json({ record: errorItem(record, lookup, titles, { full: true }) });
    } catch (e) {
      next(e);
    }
  });

  app.get("/api/errors/summary", async (req, res, next) => {
    try {
      if (refusedCrossSite(req, res)) return;
      touchIdle();
      const lookup = await classificationLookup();
      let summary;
      try {
        summary = await errors.summarize(lookup.byClaude);
      } catch (e) {
        return sendErrorLogError(res, e);
      }
      const project = await projectFor(req.query.project);
      const plans = project ? (await listSuperpowersPlans(project.root)).total : null;
      res.json({ counts: summary.counts, plans, project: project ? projectView(project) : null, error_log: errors.where, error_store: errors.kind });
    } catch (e) {
      next(e);
    }
  });

  // Past errors like a piece of text (for agents: "has this gone wrong before?"). Pinecone matches by meaning;
  // the local store, and Pinecone when offline, match by shared words (src/vector-cache.js).
  const searchOff = (res) => res.status(404).json(errorBody("FEATURE_OFF", "Error search is off. Set USE_ERROR_SEARCH=true, then run see-plan stop so the next command restarts the server."));

  app.get("/api/errors/similar", async (req, res, next) => {
    try {
      if (refusedCrossSite(req, res)) return;
      if (!errorSearch) return searchOff(res);
      const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
      if (!q) return res.status(400).json(errorBody("VALIDATION_ERROR", "q (the text to match) is required"));
      if (q.length > MAX_SIMILAR_QUERY) return res.status(400).json(errorBody("VALIDATION_ERROR", `q must be at most ${MAX_SIMILAR_QUERY} characters`));
      const context = enumParam(req.query.context, ERROR_CONTEXTS);
      const severity = enumParam(req.query.severity, SEVERITY_FILTERS);
      if (context === null) return res.status(400).json(errorBody("VALIDATION_ERROR", `context must be one of ${ERROR_CONTEXTS.join(", ")}`));
      if (severity === null) return res.status(400).json(errorBody("VALIDATION_ERROR", `severity must be one of ${SEVERITY_FILTERS.join(", ")}`));
      const limit = intParam(req.query.limit, 5, 1, 50);
      touchIdle();
      const lookup = await classificationLookup();
      let found;
      try {
        found = await errors.similar(q, { limit, context, severity }, lookup.byClaude);
      } catch (e) {
        return sendErrorLogError(res, e);
      }
      const titles = await titlesFor(found.matches.map((m) => m.record.claude_session_id));
      res.json({
        engine: found.engine,
        ...(found.fallback ? { fallback: found.fallback } : {}),
        matches: found.matches.map((m) => ({ score: m.score, ...errorItem(m.record, lookup, titles) })),
        error_store: errors.kind,
      });
    } catch (e) {
      next(e);
    }
  });

  app.get("/api/errors/store", async (req, res, next) => {
    try {
      if (refusedCrossSite(req, res)) return;
      if (!errorSearch) return searchOff(res);
      res.json({ store: await errors.describe() });
    } catch (e) {
      next(e);
    }
  });

  app.post("/api/errors/rate", async (req, res, next) => {
    try {
      if (!requireSameOrigin(req)) {
        return res.status(403).json(errorBody("FORBIDDEN_ORIGIN", "Ratings must come from the error log page"));
      }
      const body = req.body ?? {};
      const ref = recordRef(body);
      if (!ref) return res.status(400).json(errorBody("VALIDATION_ERROR", "claude_session_id, uuid and part are required"));
      if (!isSeverity(body.severity)) {
        return res.status(400).json(errorBody("VALIDATION_ERROR", `severity must be one of ${SEVERITIES.join(", ")}`));
      }
      if (body.reason !== undefined && body.reason !== null && typeof body.reason !== "string") {
        return res.status(400).json(errorBody("VALIDATION_ERROR", "reason must be a string"));
      }
      const reason = typeof body.reason === "string" ? body.reason.trim() : "";
      if (reason.length > MAX_REASON) {
        return res.status(400).json(errorBody("VALIDATION_ERROR", `reason must be at most ${MAX_REASON} characters`));
      }
      let rated;
      try {
        rated = await errors.rate(ref, body.severity, reason);
      } catch (e) {
        return sendErrorLogError(res, e);
      }
      res.json({ ok: true, ...rated });
    } catch (e) {
      next(e);
    }
  });

  // ---- projects (D9-D13): the CLI registers a project root; the page lists its superpowers plans ----

  const normPath = (p) => (process.platform === "win32" ? String(p).toLowerCase() : String(p));

  function projectView(p) {
    return { key: p.key, name: p.name, root: p.root, url: `/errors?project=${encodeURIComponent(p.key)}` };
  }

  /** The registered project for ?project= / :project, or null (unknown or malformed key). */
  function projectFor(key) {
    return isProjectKey(key) ? getProject(store, key) : Promise.resolve(null);
  }

  /** The project's plans (D12), joined with their review sessions and error counts. */
  async function projectPlans(project) {
    const [listing, lookup] = await Promise.all([listSuperpowersPlans(project.root), classificationLookup()]);
    const summary = await errorSummary(lookup);
    const byFile = new Map(); // a plan file (or the .html made from it) -> its most recently updated review session
    for (const s of lookup.sessions) {
      for (const f of [s.source_file, s.file]) {
        if (typeof f !== "string") continue;
        const k = normPath(f);
        const prev = byFile.get(k);
        if (!prev || String(prev.updated_at ?? "") < String(s.updated_at ?? "")) byFile.set(k, s);
      }
    }
    const items = listing.items.map((p) => {
      const s = byFile.get(normPath(p.file)) ?? null;
      const errors = s ? summary.byReview.get(s.key) : null;
      return {
        name: p.name,
        file: p.file,
        title: p.title || null,
        created_at: p.created_at,
        modified_at: p.modified_at,
        review_key: s?.key ?? null,
        status: s ? planStatus(s) : "Not opened",
        stage: s ? effectiveStage(s) : null,
        error_count: errors?.count ?? 0,
        worst_severity: errors?.worst ?? null,
        url: s ? `/session/${encodeURIComponent(s.key)}` : null,
      };
    });
    return { items, total: listing.total };
  }

  // The only route that takes a directory: the CLI's working directory. Only a D9 project root is registered.
  app.post("/api/projects", async (req, res, next) => {
    try {
      if (isCrossSite(req) || !req.is("application/json")) {
        return res.status(403).json(errorBody("FORBIDDEN_ORIGIN", "Projects are registered by the see-plan CLI"));
      }
      const dir = req.body?.dir;
      if (typeof dir !== "string" || !dir || dir.includes("\0") || dir.length > 4096 || !path.isAbsolute(dir)) {
        return res.status(400).json(errorBody("VALIDATION_ERROR", "dir must be an absolute path"));
      }
      const root = await findProjectRoot(dir, { home: projectHome });
      if (!root) return res.json({ project: null, url: "/errors" });
      const view = projectView(await registerProject(store, root));
      res.json({ project: view, url: view.url });
    } catch (e) {
      next(e);
    }
  });

  app.get("/api/projects", async (req, res, next) => {
    try {
      if (refusedCrossSite(req, res)) return;
      const limit = intParam(req.query.limit, 5, 1, 50);
      res.json({ projects: (await listProjects(store, { limit })).map(projectView) });
    } catch (e) {
      next(e);
    }
  });

  app.get("/api/projects/:project/plans", async (req, res, next) => {
    try {
      if (refusedCrossSite(req, res)) return;
      const project = await projectFor(req.params.project);
      if (!project) return res.status(404).json(errorBody("NOT_FOUND", "Unknown project"));
      touchIdle();
      const plans = await projectPlans(project);
      res.json({ project: projectView(project), items: plans.items, total: plans.total, next_offset: null });
    } catch (e) {
      next(e);
    }
  });

  app.post("/api/projects/:project/plans/open", async (req, res, next) => {
    try {
      if (!requireSameOrigin(req)) {
        return res.status(403).json(errorBody("FORBIDDEN_ORIGIN", "Plans are opened from the error log page"));
      }
      const project = await projectFor(req.params.project);
      if (!project) return res.status(404).json(errorBody("NOT_FOUND", "Unknown project"));
      const name = req.body?.name;
      if (!isPlanFileName(name)) return res.status(400).json(errorBody("VALIDATION_ERROR", "name must be a plan file name"));
      // Only a file in the current listing: never a path built from what the client sent.
      const plan = (await listSuperpowersPlans(project.root)).items.find((p) => p.name === name);
      if (!plan) return res.status(404).json(errorBody("NOT_FOUND", "No such plan in this project"));
      let real;
      let source;
      try {
        if (isMarkdownPath(plan.file)) {
          source = await canonicalFile(plan.file);
          real = await canonicalFile((await ensurePlanHtml(source)).htmlPath);
        } else {
          await assertHtmlFile(plan.file);
          real = await canonicalFile(plan.file);
        }
      } catch (e) {
        if (e.code === "VALIDATION_ERROR") return res.status(400).json(errorBody("VALIDATION_ERROR", e.message));
        throw e;
      }
      let result;
      try {
        result = await openReviewSession(real, { source_file: source });
      } catch (e) {
        return sendStoreError(res, e);
      }
      const { status, session } = result;
      res.json({ status, key: session.key, url: `/session/${encodeURIComponent(session.key)}`, stage: session.stage ?? null });
    } catch (e) {
      next(e);
    }
  });

  // Sessions live in a plain object, so a key like "__proto__" must never reach the store.
  app.param("key", (req, res, next, key) => {
    if (!SESSION_KEY.test(key)) return res.status(404).json(errorBody("NOT_FOUND", "Unknown session"));
    next();
  });

  // M2: which live session holds this file, primary or added output.
  app.get("/api/outputs/owner", async (req, res, next) => {
    try {
      if (isCrossSite(req)) return res.status(403).json(errorBody("FORBIDDEN_ORIGIN", "Cross-origin request refused"));
      if (typeof req.query.file !== "string" || !req.query.file) return res.status(400).json(errorBody("VALIDATION_ERROR", "file is required"));
      const owner = await store.findOutputOwner(req.query.file);
      res.json(owner ? { key: owner.key, file: owner.file, source_file: owner.source_file ?? null } : { key: null });
    } catch (e) {
      next(e);
    }
  });

  app.post("/api/:key/outputs", async (req, res, next) => {
    try {
      if (isCrossSite(req) || !req.is("application/json")) return res.status(403).json(errorBody("FORBIDDEN_ORIGIN", "Cross-origin request refused"));
      const { files } = req.body ?? {};
      if (!Array.isArray(files) || !files.length || !files.every((f) => typeof f === "string" && f)) {
        return res.status(400).json(errorBody("VALIDATION_ERROR", "files must be a non-empty array of paths"));
      }
      const items = [];
      for (const f of files) {
        const kind = kindOf(f);
        if (!kind) return res.status(400).json(errorBody("VALIDATION_ERROR", `see-plan can't show this kind of file: ${f}`));
        let real;
        try {
          real = await canonicalFile(f);
          if (!(await fs.promises.stat(real)).isFile()) throw new Error("not a file");
        } catch {
          return res.status(400).json(errorBody("VALIDATION_ERROR", `File not found: ${f}`));
        }
        if (kind === "markdown") await ensurePlanHtml(real);
        items.push({ file: real, kind });
      }
      let result;
      try {
        result = await store.addOutputs(req.params.key, items);
      } catch (e) {
        return sendStoreError(res, e);
      }
      for (const o of result.added) {
        await saveOutputRevision(stateDir, req.params.key, o.id, 0, o.file).catch(() => {});
        await watchOutput(req.params.key, o);
      }
      const session = await store.getSession(req.params.key);
      if (result.added.length) broadcast(req.params.key, { type: "outputs", outputs: outputsView(session), added: result.added.map((o) => o.id) });
      res.json({ outputs: outputsView(session), added: result.added.map((o) => o.id) });
    } catch (e) {
      next(e);
    }
  });

  app.delete("/api/:key/outputs/:id", async (req, res, next) => {
    try {
      if (isCrossSite(req)) return res.status(403).json(errorBody("FORBIDDEN_ORIGIN", "Cross-origin request refused"));
      try {
        await store.removeOutput(req.params.key, req.params.id);
      } catch (e) {
        return sendStoreError(res, e);
      }
      const name = `${req.params.key}:o:${req.params.id}`;
      const w = watchers.get(name);
      watchers.delete(name);
      await w?.close();
      const session = await store.getSession(req.params.key);
      broadcast(req.params.key, { type: "outputs", outputs: outputsView(session), removed: req.params.id });
      res.json({ outputs: outputsView(session) });
    } catch (e) {
      next(e);
    }
  });

  app.post("/api/:key/prompts", async (req, res, next) => {
    try {
      if (!requireSameOrigin(req)) {
        return res.status(403).json(errorBody("FORBIDDEN_ORIGIN", "Prompts must come from the session page"));
      }
      const { key } = req.params;
      const { prompts, dom_snapshot, end } = req.body ?? {};
      const valid = Array.isArray(prompts)
        && prompts.every((p) => p && isText(p.prompt_id) && typeof p.prompt === "string");
      if (!valid) {
        return res.status(400).json(errorBody("VALIDATION_ERROR", "prompts must be an array of { prompt_id, prompt }"));
      }
      // M6: the page names the output; the server fills in what the agent sees, and drops an unknown id.
      const owner = await store.getSession(key);
      const tagged = prompts.map((p) => {
        const { output, ...rest } = p;
        const view = owner ? promptOutput(owner, output) : undefined;
        return view ? { ...rest, output: view } : rest;
      });
      let accepted;
      try {
        ({ accepted } = await store.queuePrompts(key, {
          prompts: tagged,
          dom_snapshot: typeof dom_snapshot === "string" ? dom_snapshot : "",
          end: Boolean(end),
        }));
      } catch (e) {
        return sendStoreError(res, e);
      }
      const agentNear = Boolean(activePolls.get(key)?.listening) || inGrace(key);
      if (accepted > 0) {
        events.emit("feedback", key);
        log(`feedback sent: ${accepted} note(s)${end ? " and ended" : ""}`);
      }
      for (const p of prompts) {
        if (p.tag !== "chat") continue;
        const inferred = inferStageFromText(p.prompt);
        if (!inferred) continue;
        const r = await store.setStage(key, inferred, "text").catch(() => null);
        if (r?.changed) broadcast(key, { type: "stage", stage: r.stage, source: r.stage_source });
      }
      const session = await broadcastChat(key);
      if (end) {
        agents.delete(key);
      lastPresence.delete(key);
        clearGrace(key);
        events.emit("ended", key);
        broadcast(key, { type: "ended", ended_by: "user" });
      }
      res.json({ accepted, delivered: agentNear ? "queued-for-agent" : "queued", chat: serializeChat(session?.chat ?? []) });
    } catch (e) {
      next(e);
    }
  });

  app.post("/api/:key/agent-reply", async (req, res, next) => {
    try {
      const { text } = req.body ?? {};
      if (!isText(text)) return res.status(400).json(errorBody("VALIDATION_ERROR", "text is required"));
      try {
        await store.appendAgentReply(req.params.key, text);
      } catch (e) {
        return sendStoreError(res, e);
      }
      await broadcastChat(req.params.key);
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  app.post("/api/:key/end", async (req, res, next) => {
    try {
      const { key } = req.params;
      // Cross-site sources were refused by the origin guard: any source left is the page itself.
      const fromBrowser = (req.headers.origin ?? req.headers.referer) !== undefined;
      let endedBy = fromBrowser ? "user" : "agent";
      const current = await store.getSession(key);
      if (current?.status === "ended") return res.json({ ok: true, ended_by: current.ended_by });
      try {
        await store.endSession(key, endedBy);
      } catch (e) {
        return sendStoreError(res, e);
      }
      agents.delete(key);
      lastPresence.delete(key);
      clearGrace(key);
      events.emit("ended", key);
      broadcast(key, { type: "ended", ended_by: endedBy });
      log(`session ended by ${endedBy}`);
      res.json({ ok: true, ended_by: endedBy });
    } catch (e) {
      next(e);
    }
  });

  app.post("/api/:key/new-session", async (req, res, next) => {
    try {
      if (!requireSameOrigin(req)) {
        return res.status(403).json(errorBody("FORBIDDEN_ORIGIN", "New sessions must be started from the session page"));
      }
      const { key } = req.params;
      let session;
      try {
        session = await store.startNewSession(key);
      } catch (e) {
        return sendStoreError(res, e);
      }
      claudeLinks.delete(key);
      agents.delete(key);
      lastPresence.delete(key);
      broadcast(key, { type: "new-session" });
      res.json({ ok: true, status: session.status });
    } catch (e) {
      next(e);
    }
  });

  // The panel's stage dropdown (source "human") or `see-plan stage <file> <name>` (source "flag").
  app.post("/api/:key/stage", async (req, res, next) => {
    try {
      const fromPage = (req.headers.origin ?? req.headers.referer) !== undefined;
      if (fromPage ? !requireSameOrigin(req) : !req.is("application/json")) {
        return res.status(fromPage ? 403 : 415).json(errorBody(fromPage ? "FORBIDDEN_ORIGIN" : "UNSUPPORTED_MEDIA_TYPE", "Refused"));
      }
      const { stage } = req.body ?? {};
      if (stage !== null && !isStage(stage)) {
        return res.status(400).json(errorBody("VALIDATION_ERROR", `stage must be null or one of ${STAGES.join(", ")}`));
      }
      let r;
      try {
        r = await store.setStage(req.params.key, stage, fromPage ? "human" : "flag");
      } catch (e) {
        return sendStoreError(res, e);
      }
      if (r.changed) broadcast(req.params.key, { type: "stage", stage: r.stage, source: r.stage_source });
      res.json({ ok: true, ...r });
    } catch (e) {
      next(e);
    }
  });

  app.get("/api/:key/status", async (req, res, next) => {
    try {
      if (isCrossSite(req)) {
        return res.status(403).json(errorBody("FORBIDDEN_ORIGIN", "Cross-origin request refused"));
      }
      const s = await store.getSession(req.params.key);
      if (!s) return res.status(404).json({ status: "missing" });
      res.json({
        session: {
          file: s.source_file ?? s.file,
          status: s.status,
          ...(s.ended_by ? { ended_by: s.ended_by } : {}),
          stage: s.stage ?? null,
          stage_source: s.stage_source ?? null,
          listening: Boolean(activePolls.get(s.key)?.listening) || inGrace(s.key),
          queued_prompts: s.prompts.length,
          claude_session_id: s.claude_session_id ?? null,
          revision: s.revision,
          ...(s.workflow_id ? { workflow_id: s.workflow_id } : {}),
          ...(s.decision ? { decision: s.decision.value } : {}),
        },
      });
    } catch (e) {
      next(e);
    }
  });

  app.post("/api/:key/session-feedback", async (req, res, next) => {
    try {
      if (!requireSameOrigin(req)) {
        return res.status(403).json(errorBody("FORBIDDEN_ORIGIN", "Session feedback must come from the session page"));
      }
      const { key } = req.params;
      const { rating, categories = [], text = "" } = req.body ?? {};
      const valid = (rating === "up" || rating === "down")
        && Array.isArray(categories) && categories.length <= SESSION_FEEDBACK_CATEGORIES.length
        && categories.every((c) => SESSION_FEEDBACK_CATEGORIES.includes(c))
        && typeof text === "string" && text.length <= MAX_FEEDBACK_TEXT;
      if (!valid) {
        return res.status(400).json(errorBody("VALIDATION_ERROR", `rating must be up or down; categories from ${SESSION_FEEDBACK_CATEGORIES.join(", ")}`));
      }
      const session = await store.getSession(key);
      if (!session) return res.status(404).json(errorBody("MISSING", `no session ${key}`));
      const target = { rating, categories: [...new Set(categories)], claude_session_id: session.claude_session_id ?? null, stage: session.stage ?? null };
      const titles = target.categories.map((c) => CATEGORY_TITLES[c]);
      const prompt = {
        prompt_id: crypto.randomUUID(),
        prompt: `Session feedback: ${rating === "up" ? "👍" : "👎"}${titles.length ? ` (${titles.join(", ")})` : ""}${text.trim() ? ` ${text.trim()}` : ""}`,
        tag: "session-feedback",
        selector: "",
        text: "",
        target,
      };
      let accepted;
      try {
        ({ accepted } = await store.queuePrompts(key, { prompts: [prompt] }));
      } catch (e) {
        return sendStoreError(res, e);
      }
      await appendFeedback(feedbackFile, { kind: "session", key, file: session.source_file ?? session.file, ...target, text: text.trim(), at: new Date().toISOString() });
      if (accepted) events.emit("feedback", key);
      const updated = await broadcastChat(key);
      res.json({ ok: true, chat: serializeChat(updated?.chat ?? []) });
    } catch (e) {
      next(e);
    }
  });

  /** Opens (or reuses) the session for one workflow stage and returns it. */
  async function openStageSession(wf, stage) {
    const target = await ensureStageFile(wf, stage);
    let file = target;
    let sourceFile;
    if (isMarkdownPath(target)) {
      sourceFile = await canonicalFile(target);
      file = (await ensurePlanHtml(target)).htmlPath;
    }
    const real = await canonicalFile(file);
    const { session } = await store.upsertSession(real, baseUrl, { reopen: true, source_file: sourceFile, stage, workflow_id: wf.id });
    if (session.revision === 0) await saveRevision(stateDir, session.key, 0, { file: session.file, sourceFile }).catch(() => {});
    await watchSession(session);
    await updateStage(store, wf.id, stage, { key: session.key });
    return session;
  }

  /** Stage N is done or skipped: open stage N+1's session and tell the page. */
  async function advance(wf, from, { skipped = false } = {}) {
    const { workflow, next } = await advanceWorkflow(store, wf.id, { from, skipped });
    let nextSession = null;
    if (next) nextSession = await openStageSession(workflow, next);
    const fromKey = workflow.stages[from].key;
    const message = { type: "stage-ready", workflow_id: workflow.id, from, next, next_url: nextSession?.url ?? null, next_key: nextSession?.key ?? null };
    if (fromKey) broadcast(fromKey, message);
    notifyHome();
    return { workflow: await getWorkflow(store, workflow.id), next, next_url: message.next_url, next_key: message.next_key };
  }

  app.post("/api/:key/decision", async (req, res, next) => {
    try {
      if (!requireSameOrigin(req)) {
        return res.status(403).json(errorBody("FORBIDDEN_ORIGIN", "Decisions must come from the session page"));
      }
      const { key } = req.params;
      const { decision, comment = "", force = false } = req.body ?? {};
      if ((decision !== "approve" && decision !== "request-changes") || typeof comment !== "string" || comment.length > MAX_FEEDBACK_TEXT) {
        return res.status(400).json(errorBody("VALIDATION_ERROR", "decision must be approve or request-changes"));
      }
      if (decision === "request-changes" && !comment.trim()) {
        return res.status(400).json(errorBody("VALIDATION_ERROR", "Say what should change"));
      }
      const before = await store.getSession(key);
      if (!before) return res.status(404).json(errorBody("MISSING", `no session ${key}`));
      const stageName = STAGE_TITLES[before.stage] ?? "plan";
      const prompt = {
        prompt_id: crypto.randomUUID(),
        prompt: decision === "approve"
          ? `Approved the ${stageName.toLowerCase()}.${comment.trim() ? ` ${comment.trim()}` : ""}`
          : `Request changes: ${comment.trim()}`,
        tag: "decision",
        selector: "",
        text: "",
        target: { decision, comment: comment.trim(), stage: before.stage ?? null, revision: before.revision },
      };
      let session;
      try {
        session = await store.setDecision(key, { value: decision, comment: comment.trim(), prompt, force: force === true });
      } catch (e) {
        return sendStoreError(res, e);
      }
      await appendFeedback(feedbackFile, { kind: "decision", key, file: session.source_file ?? session.file, decision, comment: comment.trim(), stage: session.stage ?? null, revision: session.revision, at: new Date().toISOString() });
      events.emit("feedback", key);
      await broadcastChat(key);
      const out = { ok: true, decision, status: session.status };
      const wf = session.workflow_id ? await getWorkflow(store, session.workflow_id) : null;
      if (decision === "approve") {
        agents.delete(key);
        lastPresence.delete(key);
        clearGrace(key);
        events.emit("ended", key);
        broadcast(key, { type: "ended", ended_by: "approved" });
        if (wf && wf.current === session.stage) Object.assign(out, await advance(wf, session.stage));
      } else if (wf && session.stage === "verification" && wf.current === "verification") {
        // Rejected verification: back to implementation with the issues queued as feedback.
        const reopened = await reopenStage(store, wf.id, "implementation");
        const implKey = reopened.stages.implementation.key;
        if (implKey) {
          const impl = await store.getSession(implKey);
          if (impl?.status === "ended") await store.reopenSession(implKey);
          await store.queuePrompts(implKey, {
            prompts: [{ prompt_id: crypto.randomUUID(), prompt: `Verification found issues: ${comment.trim()}`, tag: "decision", selector: "", text: "", target: { decision: "request-changes", from: "verification" } }],
          });
          events.emit("feedback", implKey);
          await broadcastChat(implKey);
          const implSession = await store.getSession(implKey);
          const message = { type: "stage-ready", workflow_id: wf.id, from: "verification", next: "implementation", next_url: implSession.url, next_key: implKey, reopened: true };
          broadcast(key, message);
          Object.assign(out, { next: "implementation", next_url: implSession.url, next_key: implKey, workflow: reopened });
        }
      }
      res.json(out);
    } catch (e) {
      next(e);
    }
  });

  app.post("/api/:key/reopen", async (req, res, next) => {
    try {
      if (!requireSameOrigin(req)) {
        return res.status(403).json(errorBody("FORBIDDEN_ORIGIN", "Reopen must come from the session page"));
      }
      let session;
      try {
        session = await store.reopenSession(req.params.key);
      } catch (e) {
        return sendStoreError(res, e);
      }
      broadcast(req.params.key, { type: "new-session" });
      res.json({ ok: true, status: session.status });
    } catch (e) {
      next(e);
    }
  });

  app.post("/api/:key/archive", async (req, res, next) => {
    try {
      if (!requireSameOrigin(req)) {
        return res.status(403).json(errorBody("FORBIDDEN_ORIGIN", "Archive must come from the dashboard"));
      }
      try {
        await store.setArchived(req.params.key, req.body?.archived !== false);
      } catch (e) {
        return sendStoreError(res, e);
      }
      notifyHome();
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  app.get("/api/sessions", async (req, res, next) => {
    try {
      if (isCrossSite(req)) {
        return res.status(403).json(errorBody("FORBIDDEN_ORIGIN", "Cross-origin request refused"));
      }
      const snap = await homeSnapshot();
      res.json({ sessions: snap.sessions, workflows: snap.workflows });
    } catch (e) {
      next(e);
    }
  });

  app.post("/api/prune", async (req, res, next) => {
    try {
      if (!req.is("application/json")) {
        return res.status(415).json(errorBody("UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json"));
      }
      const dryRun = req.body?.dry_run === true;
      const removed = await store.pruneMissing({ dryRun });
      if (!dryRun) {
        for (const { key } of removed) {
          for (const k of [key, `${key}:md`]) {
            const w = watchers.get(k);
            watchers.delete(k);
            if (w) track(w.close());
          }
        }
        notifyHome();
      }
      res.json({ removed, dry_run: dryRun });
    } catch (e) {
      next(e);
    }
  });

  async function outputRevisionHtml(session, output, n) {
    const buf = await readOutputRevision(stateDir, session.key, output.id, n);
    if (!buf) return null;
    if (output.kind === "html") return buf.toString("utf8");
    if (output.kind === "markdown") return withMermaid(renderPlanHtml(buf.toString("utf8"), { title: path.parse(output.file).name }));
    if (output.kind === "image") return renderOutputPage({ kind: "image", file: output.file, imageSrc: `data:${imageType(output.file)};base64,${buf.toString("base64")}` });
    return renderOutputPage({ kind: output.kind, file: output.file, text: buf.toString("utf8") });
  }

  app.get("/api/:key/revisions", async (req, res, next) => {
    try {
      if (isCrossSite(req)) {
        return res.status(403).json(errorBody("FORBIDDEN_ORIGIN", "Cross-origin request refused"));
      }
      const s = await store.getSession(req.params.key);
      if (!s) return res.status(404).json(errorBody("MISSING", `no session ${req.params.key}`));
      const outputId = typeof req.query.output === "string" && req.query.output !== "main" ? req.query.output : null;
      if (outputId) {
        const o = getOutput(s, outputId);
        if (!o) return res.status(404).json(errorBody("MISSING", `no output ${outputId}`));
        return res.json({ revision: o.revision ?? 0, revisions: await listOutputRevisions(stateDir, s.key, o.id) });
      }
      res.json({ revision: s.revision, revisions: await listRevisions(stateDir, s.key) });
    } catch (e) {
      next(e);
    }
  });

  app.get("/api/:key/revisions/:n", async (req, res, next) => {
    try {
      if (isCrossSite(req)) {
        return res.status(403).json(errorBody("FORBIDDEN_ORIGIN", "Cross-origin request refused"));
      }
      const s = await store.getSession(req.params.key);
      if (!s) return res.status(404).json(errorBody("MISSING", `no session ${req.params.key}`));
      const outputId = typeof req.query.output === "string" && req.query.output !== "main" ? req.query.output : null;
      const o = outputId ? getOutput(s, outputId) : null;
      if (outputId && !o) return res.status(404).json(errorBody("MISSING", `no output ${outputId}`));
      const html = o
        ? await outputRevisionHtml(s, o, Number(req.params.n))
        : await readRevision(stateDir, s.key, Number(req.params.n));
      if (html === null) return res.status(404).json(errorBody("NOT_FOUND", "No such revision"));
      res.set("Cache-Control", "no-cache");
      res.json({ n: Number(req.params.n), html });
    } catch (e) {
      next(e);
    }
  });

  // ---- workflows: Plan → Interrogation → Implementation → Verification ----

  app.post("/api/workflows", async (req, res, next) => {
    try {
      const fromPage = (req.headers.origin ?? req.headers.referer) !== undefined;
      if (fromPage ? !requireSameOrigin(req) : !req.is("application/json")) {
        return res.status(fromPage ? 403 : 415).json(errorBody(fromPage ? "FORBIDDEN_ORIGIN" : "UNSUPPORTED_MEDIA_TYPE", "Refused"));
      }
      const { name, dir, requirements, requirements_file: reqFile } = req.body ?? {};
      if (!isFeatureName(name)) {
        return res.status(400).json(errorBody("VALIDATION_ERROR", "name must be letters, digits, dot, dash or underscore (max 64)"));
      }
      if (typeof dir !== "string" || !path.isAbsolute(dir)) {
        return res.status(400).json(errorBody("VALIDATION_ERROR", "dir must be an absolute folder path"));
      }
      const st = await fs.promises.stat(dir).catch(() => null);
      if (!st?.isDirectory()) return res.status(400).json(errorBody("VALIDATION_ERROR", "dir must be an existing folder"));
      const realDir = await fs.promises.realpath(dir);
      const reqPath = requirementsFile(realDir, name);
      if (typeof requirements === "string" && requirements.trim()) {
        if (requirements.length > 200000) return res.status(400).json(errorBody("VALIDATION_ERROR", "requirements are too long"));
        await fs.promises.writeFile(reqPath, requirements.endsWith("\n") ? requirements : requirements + "\n");
      } else if (typeof reqFile === "string" && reqFile) {
        try {
          await fs.promises.copyFile(reqFile, reqPath);
        } catch {
          return res.status(400).json(errorBody("VALIDATION_ERROR", "requirements_file not readable"));
        }
      } else if (!(await fs.promises.stat(reqPath).catch(() => null))) {
        return res.status(400).json(errorBody("VALIDATION_ERROR", "requirements (text) or requirements_file is required"));
      }
      const wf = await createWorkflow(store, { name, dir: realDir, requirements_file: reqPath });
      const stage = wf.current ?? "plan";
      const session = wf.stages[stage]?.key ? await store.getSession(wf.stages[stage].key) : await openStageSession(wf, stage);
      notifyHome();
      res.json({ workflow: await getWorkflow(store, wf.id), key: session.key, url: session.url, stage });
    } catch (e) {
      next(e);
    }
  });

  app.get("/api/workflows", async (req, res, next) => {
    try {
      if (isCrossSite(req)) return res.status(403).json(errorBody("FORBIDDEN_ORIGIN", "Cross-origin request refused"));
      res.json({ workflows: await listWorkflows(store) });
    } catch (e) {
      next(e);
    }
  });

  app.get("/api/workflows/:id", async (req, res, next) => {
    try {
      if (isCrossSite(req)) return res.status(403).json(errorBody("FORBIDDEN_ORIGIN", "Cross-origin request refused"));
      const wf = await getWorkflow(store, req.params.id);
      if (!wf) return res.status(404).json(errorBody("MISSING", "no such workflow"));
      res.json({ workflow: wf });
    } catch (e) {
      next(e);
    }
  });

  app.post("/api/workflows/:id/skip", async (req, res, next) => {
    try {
      if (!requireSameOrigin(req)) {
        return res.status(403).json(errorBody("FORBIDDEN_ORIGIN", "Skip must come from the page"));
      }
      const wf = await getWorkflow(store, req.params.id);
      if (!wf) return res.status(404).json(errorBody("MISSING", "no such workflow"));
      if (!wf.current) return res.status(409).json(errorBody("WORKFLOW_DONE", "Every stage is finished"));
      try {
        res.json({ ok: true, ...(await advance(wf, wf.current, { skipped: true })) });
      } catch (e) {
        return sendStoreError(res, e);
      }
    } catch (e) {
      next(e);
    }
  });

  // findClaude caches its `where`/`which` lookup; the strategy follows the session's newest caller (H2, H3).
  app.get("/api/claude-status", async (req, res, next) => {
    try {
      if (isCrossSite(req)) {
        return res.status(403).json(errorBody("FORBIDDEN_ORIGIN", "Cross-origin request refused"));
      }
      const key = typeof req.query.key === "string" && SESSION_KEY.test(req.query.key) ? req.query.key : null;
      res.json(await claudeStatus({ environment: key ? environmentFor(key) : detectEnvironment(), settings: launcherConfig }));
    } catch (e) {
      next(e);
    }
  });

  app.post("/api/:key/connect-cancel", async (req, res) => {
    if (!requireSameOrigin(req)) {
      return res.status(403).json(errorBody("FORBIDDEN_ORIGIN", "Cancel must come from the session page"));
    }
    pendingLaunch.delete(req.params.key);
    res.json({ ok: true });
  });

  app.post("/api/:key/connect-claude", async (req, res, next) => {
    try {
      // The origin guard already refused cross-site callers; header-less CLI calls pass but must send JSON.
      if (!req.is("application/json")) {
        return res.status(415).json(errorBody("UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json"));
      }
      const { key } = req.params;
      const session = await store.getSession(key);
      if (!session) return res.status(404).json(errorBody("MISSING", `no session ${key}`));
      if (session.status === "ended") return res.status(409).json(errorBody("ENDED", "session ended"));
      const wf = session.workflow_id ? await getWorkflow(store, session.workflow_id) : null;
      if (wf && session.stage && wf.stages[session.stage]?.status === "locked") {
        return res.status(409).json(errorBody("STAGE_LOCKED", `Finish (approve) or skip ${STAGE_TITLES[wf.current] ?? "the current stage"} first`));
      }
      if (activePolls.get(key)?.listening) {
        return res.status(409).json(errorBody("LISTENER_ACTIVE", "An agent is already polling this session"));
      }
      if (inGrace(key)) {
        return res.status(409).json(errorBody("AGENT_RECONNECTING", "The agent is reconnecting; it is still connected"));
      }
      const launchedAt = pendingLaunch.get(key);
      if (launchedAt !== undefined && Date.now() - launchedAt < connectCooldownMs) {
        return res.status(409).json(errorBody("CONNECT_PENDING", "A Claude window was just started; wait for it to begin polling"));
      }
      const resume = req.body?.resume === true;
      let sessionId = crypto.randomUUID();
      if (resume) {
        const id = session.claude_session_id;
        if (!isClaudeSessionId(id) || !(await findTranscript(id, { claudeDir }))) {
          return res.status(409).json(errorBody("NOTHING_TO_RESUME", "This session has no earlier Claude conversation to resume"));
        }
        sessionId = id;
      }
      const launch = Date.now();
      pendingLaunch.set(key, launch); // set before any await so a double click cannot start two windows
      const file = session.source_file ?? session.file;
      let launched;
      try {
        launched = await launchClaude({
          file,
          cwd: await findRepoRoot(session.dir),
          sessionId,
          resume,
          prompt: wf && session.stage
            ? buildPrompt({
              file,
              feature: wf.name,
              stage: session.stage,
              instructions: stageInstructions(session.stage, {
                requirements: wf.requirements_file,
                plan: stageFile(wf, "plan"),
                artifact: stageFile(wf, session.stage),
              }),
            })
            : buildPrompt({ file, stage: session.stage }),
          feature: wf?.name,
          environment: environmentFor(key), // H2: where the newest see-plan command for this session ran
          config: launcherConfig,
        });
      } catch (e) {
        if (pendingLaunch.get(key) === launch) pendingLaunch.delete(key);
        const status = LAUNCH_ERROR_STATUS[e?.code];
        if (!status) throw e;
        return res.status(status).json(errorBody(e.code, e.message));
      }
      if (!resume) await linkClaudeSession(key, sessionId);
      if (wf && session.stage) await updateStage(store, wf.id, session.stage, { claude_session_id: sessionId });
      const mode = launched?.mode ?? "powershell";
      log(`Connect Claude launched: ${titleOf(session)} (${launched?.strategy ?? mode})`);
      res.json({
        ok: true, claude_session_id: sessionId, mode,
        ...(launched?.strategy ? { strategy: launched.strategy } : {}),
        ...(launched?.strategy_reasons ? { strategy_reasons: launched.strategy_reasons } : {}),
        ...(launched?.tmux_window ? { tmux_window: launched.tmux_window } : {}),
        ...(launched?.command ? { command: launched.command } : {}),
      });
    } catch (e) {
      next(e);
    }
  });

  app.post("/api/:key/claude-session", async (req, res, next) => {
    try {
      if (!req.is("application/json")) {
        return res.status(415).json(errorBody("UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json"));
      }
      const { key } = req.params;
      const { id } = req.body ?? {};
      if (!isClaudeSessionId(id)) {
        return res.status(400).json(errorBody("VALIDATION_ERROR", "id must be a Claude session UUID"));
      }
      try {
        await linkClaudeSession(key, id);
      } catch (e) {
        return sendStoreError(res, e);
      }
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  app.get("/api/:key/claude-log", async (req, res, next) => {
    try {
      if (isCrossSite(req)) {
        return res.status(403).json(errorBody("FORBIDDEN_ORIGIN", "Cross-origin request refused"));
      }
      const { key } = req.params;
      let link = claudeLinks.get(key);
      if (!link) {
        const session = await store.getSession(key);
        if (!session) return res.status(404).json(errorBody("MISSING", `no session ${key}`));
        link = { claudeSessionId: session.claude_session_id ?? null, transcriptPath: null };
        claudeLinks.set(key, link);
      }
      const empty = { claude_session_id: link.claudeSessionId, found: false, entries: [], next: 0, omitted: false };
      if (!link.claudeSessionId) return res.json(empty);
      if (!link.transcriptPath) link.transcriptPath = await findTranscript(link.claudeSessionId, { claudeDir });
      if (!link.transcriptPath) return res.json(empty);
      const raw = req.query.after;
      const after = raw === undefined ? undefined : Math.max(0, Math.floor(Number(raw)) || 0);
      try {
        res.json({ ...empty, found: true, ...(await readTranscript(link.transcriptPath, { after })) });
      } catch (e) {
        if (e?.code !== "ENOENT") throw e;
        link.transcriptPath = null; // the file moved or was removed: look again next time
        res.json(empty);
      }
    } catch (e) {
      next(e);
    }
  });

  app.get("/api/claude-sessions", async (req, res, next) => {
    try {
      if (isCrossSite(req)) {
        return res.status(403).json(errorBody("FORBIDDEN_ORIGIN", "Cross-origin request refused"));
      }
      const limit = intParam(req.query.limit, 20, 1, 75);
      const [sessions, lookup] = await Promise.all([claudeSessions.list({ claudeDir, limit }), classificationLookup()]);
      const summary = await errorSummary(lookup);
      res.json({
        sessions: sessions.map((s) => {
          const review = lookup.byClaude.get(s.id);
          const errors = summary.bySession.get(s.id);
          return {
            ...s,
            review_key: review?.review_key ?? null,
            stage: review?.stage ?? null,
            context: review?.context ?? "session",
            review_url: review ? `/session/${encodeURIComponent(review.review_key)}` : null,
            error_count: errors?.count ?? 0,
            worst_severity: errors?.worst ?? null,
          };
        }),
      });
    } catch (e) {
      next(e);
    }
  });

  app.get("/api/claude-sessions/:id/log", async (req, res, next) => {
    try {
      if (isCrossSite(req)) {
        return res.status(403).json(errorBody("FORBIDDEN_ORIGIN", "Cross-origin request refused"));
      }
      const { id } = req.params;
      if (!isClaudeSessionId(id)) {
        return res.status(400).json(errorBody("VALIDATION_ERROR", "id must be a Claude session UUID"));
      }
      touchIdle();
      const empty = { claude_session_id: id, found: false, entries: [], next: 0, omitted: false, last_prompt_at: null };
      const file = transcripts.get(id) ?? (await findTranscript(id, { claudeDir }));
      if (!file) return res.json(empty);
      transcripts.set(id, file);
      const raw = req.query.after;
      const after = raw === undefined ? undefined : Math.max(0, Math.floor(Number(raw)) || 0);
      let read;
      try {
        let maxBytes = PAGE_LOG_BYTES;
        read = await readTranscript(file, { after, maxBytes });
        while (after === undefined && read.omitted && read.entries.length < PAGE_MIN_ENTRIES && maxBytes < PAGE_MAX_BYTES) {
          maxBytes *= 2;
          read = await readTranscript(file, { after, maxBytes });
        }
      } catch (e) {
        if (e?.code !== "ENOENT") throw e;
        transcripts.delete(id); // the file moved or was removed: look again next time
        return res.json(empty);
      }
      const body = { ...empty, found: true, ...read };
      if (after === undefined) {
        // First read: the header needs the last prompt even when it is older than the tail window.
        if (!body.last_prompt_at) body.last_prompt_at = await findLastPromptAt(file, read.next);
        const saved = await errors.reported(id); // and the page marks entries already logged
        body.reported = saved.refs;
        body.reasons = saved.reasons;
        body.severities = saved.severities;
      }
      res.json(body);
    } catch (e) {
      next(e);
    }
  });

  // The log page's clicks: the server appends the entry itself, as no agent may be listening there.
  app.post("/api/claude-errors", async (req, res, next) => {
    try {
      if (!requireSameOrigin(req)) {
        return res.status(403).json(errorBody("FORBIDDEN_ORIGIN", "Log entries must come from the log page"));
      }
      const e = req.body?.entry;
      const valid = e && typeof e === "object"
        && isClaudeSessionId(e.claude_session_id)
        && isText(e.uuid) && e.uuid.length <= 100
        && Number.isInteger(e.part) && e.part >= 0 && e.part < 1000
        && LOG_ROLES.has(e.role) && LOG_KINDS.has(e.kind)
        && (e.at === null || (typeof e.at === "string" && e.at.length <= 64))
        && typeof e.text === "string" && e.text.length <= MAX_LOG_TEXT;
      if (!valid) {
        return res.status(400).json(errorBody("VALIDATION_ERROR", "entry must be one Claude log entry"));
      }
      if (e.reason !== undefined && e.reason !== null && typeof e.reason !== "string") {
        return res.status(400).json(errorBody("VALIDATION_ERROR", "reason must be a string"));
      }
      const reason = typeof e.reason === "string" ? e.reason.trim() : "";
      if (reason.length > MAX_REASON) {
        return res.status(400).json(errorBody("VALIDATION_ERROR", `reason must be at most ${MAX_REASON} characters`));
      }
      if (!isSeverity(e.severity)) {
        return res.status(400).json(errorBody("VALIDATION_ERROR", `severity must be one of ${SEVERITIES.join(", ")}`));
      }
      if (needsReason(e.severity) && !reason) {
        return res.status(400).json(errorBody("VALIDATION_ERROR", "High and Send to IT need a reason"));
      }
      // D3: context, review key and stage come from the Claude session id alone, never from the client.
      const cls = (await classificationLookup()).byClaude.get(e.claude_session_id) ?? { context: "session", review_key: null, stage: null };
      const record = {
        claude_session_id: e.claude_session_id,
        uuid: e.uuid,
        part: e.part,
        role: e.role,
        kind: e.kind,
        at: e.at,
        text: e.text,
        reason: reason || null,
        severity: e.severity,
        context: cls.context,
        review_key: cls.review_key,
        stage: cls.stage,
        reported_at: new Date().toISOString(),
      };
      let result;
      try {
        result = await errors.append(record);
      } catch (err) {
        if (!(err instanceof ErrorLogError)) throw err;
        return res.status(409).json(errorBody(err.code, err.message));
      }
      res.json({
        ok: true,
        status: result.duplicate ? "already_logged" : (log(`error logged (${e.severity})`), "logged"),
        duplicate: result.duplicate,
        reason: result.reason, // on a duplicate, the reason saved the first time
        severity: result.severity, // ...and the severity saved the first time
        error_log: errors.where,
      });
    } catch (e) {
      next(e);
    }
  });

  // GET skips the origin guard, yet a poll consumes feedback: refuse browser cross-site loads.
  // The query never carries agent_reply (writes go through POST).
  app.get("/api/poll", (req, res, next) => {
    if (isCrossSite(req)) {
      return res.status(403).json(errorBody("FORBIDDEN_ORIGIN", "Cross-origin request refused"));
    }
    const { file, timeoutMs } = req.query ?? {};
    track(handlePoll(req, res, { file, timeoutMs }).catch(next));
  });

  app.post("/api/poll", (req, res, next) => {
    track(handlePoll(req, res, req.body ?? {}).catch(next));
  });

  async function handlePoll(req, res, { file, agent_reply: agentReply, timeoutMs: rawTimeout, agent, claude_session_id: claudeSessionId, stage }) {
    // Registered before any await so a client that vanishes early is never missed.
    let vanished = false;
    let poll = null;
    let unconfirmed = null; // feedback taken from the store but not yet fully written
    res.on("finish", () => {
      unconfirmed = null;
    });
    res.on("close", () => {
      if (res.writableFinished) return;
      vanished = true;
      restoreUnconfirmed();
      poll?.release();
    });

    function restoreUnconfirmed() {
      const taken = unconfirmed;
      unconfirmed = null;
      if (!taken) return;
      const { prompts, dom_snapshot } = taken;
      track(
        store.queuePrompts(poll.key, { prompts, dom_snapshot }, { restore: true }).then(
          ({ accepted }) => {
            if (accepted > 0) events.emit("feedback", poll.key);
          },
          (e) => log(`restore failed for ${poll.key}: ${e?.message ?? e}`),
        ),
      );
    }

    if (typeof file !== "string" || !file) {
      return res.status(400).json(errorBody("VALIDATION_ERROR", "file is required"));
    }
    const timeoutMs = parseTimeout(rawTimeout);
    if (timeoutMs === null) {
      return res.status(400).json(errorBody("VALIDATION_ERROR", "timeoutMs must be a non-negative number"));
    }
    if (agentReply !== undefined && !isText(agentReply)) {
      return res.status(400).json(errorBody("VALIDATION_ERROR", "agent_reply must be non-empty text"));
    }
    if (claudeSessionId !== undefined && !isClaudeSessionId(claudeSessionId)) {
      return res.status(400).json(errorBody("VALIDATION_ERROR", "claude_session_id must be a Claude session UUID"));
    }
    if (stage !== undefined && !isStage(stage)) {
      return res.status(400).json(errorBody("VALIDATION_ERROR", `stage must be one of ${STAGES.join(", ")}`));
    }
    let key;
    try {
      const real = await canonicalFile(file);
      // M2: polling any output of a review waits on that review.
      key = (await store.findOutputOwner(real))?.key ?? sessionKey(real);
    } catch {
      return res.status(404).json({ status: "missing" });
    }
    const existing = await store.getSession(key);
    if (!existing) return res.status(404).json({ status: "missing" });
    rememberEnv(key, req);
    if (closing) return res.json({ status: "waiting", reconnect: true }); // S5: the next poll restarts the server
    watchSession(existing);
    if (vanished) return;
    if (activePolls.has(key)) {
      return res.status(409).json(errorBody("LISTENER_ACTIVE", "Another poll is already listening for this session"));
    }

    // Acquire the listener slot (synchronously after the check).
    let pending = false;
    let wake = null;
    let timer = null;
    const notify = () => {
      pending = true;
      wake?.();
    };
    const onEvent = (k) => {
      if (k === key) notify();
    };
    const isAgent = agent === "claude" || agent === "agent" || agent === true;
    // Agent polls end every agentPollMs so a Bash tool timeout never kills them; the agent just re-polls.
    const effectiveTimeout = isAgent && agentPollMs > 0 ? Math.min(timeoutMs || Infinity, agentPollMs) : timeoutMs;
    poll = {
      key,
      listening: false,
      agent: agent === "claude" ? "claude" : null,
      sessionId: claudeSessionId ?? null,
      delivered: false,
      notify,
      released: false,
      release() {
        if (poll.released) return;
        poll.released = true;
        events.off("feedback", onEvent);
        events.off("ended", onEvent);
        clearTimeout(timer);
        if (activePolls.get(key) === poll) activePolls.delete(key);
        const wasListening = poll.listening;
        poll.listening = false;
        if (poll.delivered) {
          clearGrace(key);
          broadcastPresence(key);
        } else if (wasListening && !startGrace(key)) {
          broadcastPresence(key);
        }
        notify();
        updateIdle();
      },
    };
    activePolls.set(key, poll);
    events.on("feedback", onEvent);
    events.on("ended", onEvent);
    updateIdle();

    try {
      // An agent's own session id fills an empty slot only: it never replaces one the user picked.
      if (poll.sessionId && !(claudeLinks.get(key)?.claudeSessionId ?? existing.claude_session_id)) {
        await linkClaudeSession(key, poll.sessionId);
      }
      if (stage !== undefined) {
        const r = await store.setStage(key, stage, "flag");
        if (r.changed) broadcast(key, { type: "stage", stage: r.stage, source: r.stage_source });
      }
      if (agentReply !== undefined) {
        await store.appendAgentReply(key, agentReply);
        await broadcastChat(key);
      }

      let result = await store.takeFeedback(key);
      let timedOut = false;
      while (result.status === "waiting" && !timedOut && !vanished && !closing) {
        if (!poll.listening) {
          poll.listening = true;
          clearGrace(key);
          lastPollAt.set(key, new Date().toISOString());
          pendingLaunch.delete(key);
          agents.set(key, { agent: poll.agent, sessionId: poll.sessionId, working: false });
          broadcastPresence(key);
          log(`poll connected: ${titleOf(existing)}${poll.agent ? ` (${poll.agent})` : ""}`);
          if (effectiveTimeout > 0) {
            timer = setTimeout(() => {
              timedOut = true;
              notify();
            }, Math.min(effectiveTimeout, MAX_TIMER_MS));
            timer.unref();
          }
        }
        if (!pending) await new Promise((resolve) => (wake = resolve));
        wake = null;
        pending = false;
        if (vanished || closing) break;
        result = await store.takeFeedback(key);
      }

      if (result.status === "feedback") unconfirmed = result;
      if (vanished) {
        restoreUnconfirmed();
        return;
      }
      if (timedOut && result.status === "waiting" && isAgent) result = { status: "waiting", reconnect: true };
      if (closing && result.status === "waiting") result = { status: "waiting", reconnect: true };
      log(result.status === "feedback"
        ? `poll returned: ${titleOf(existing)}, ${result.prompts?.length ?? 0} note(s)${result.session_ended ? ", session ended" : ""}`
        : `poll returned: ${titleOf(existing)}, ${result.reconnect ? "reconnect" : result.status}`);
      if (result.status === "feedback" && !result.session_ended) {
        agents.set(key, { agent: poll.agent, sessionId: poll.sessionId, working: true });
        poll.delivered = true;
      }
      poll.release();
      const after = await store.getSession(key);
      if (after?.stage) Object.assign(result, { stage: after.stage, stage_source: after.stage_source });
      if (after?.workflow_id) {
        const wf = await getWorkflow(store, after.workflow_id);
        if (wf) result.workflow = { id: wf.id, name: wf.name, current: wf.current, plan_file: stageFile(wf, "plan"), requirements_file: wf.requirements_file };
      }
      res.json(result);
      notifyHome();
    } finally {
      poll.release();
    }
  }

  app.get("/session/:key", async (req, res, next) => {
    try {
      const session = await store.getSession(req.params.key);
      if (!session) return res.status(404).json(errorBody("NOT_FOUND", "Unknown session"));
      res.set("X-Frame-Options", "DENY");
      res.set("Content-Security-Policy", "frame-ancestors 'none'");
      const canResume = isClaudeSessionId(session.claude_session_id)
        && Boolean(await findTranscript(session.claude_session_id, { claudeDir }).catch(() => null));
      const workflow = session.workflow_id ? await getWorkflow(store, session.workflow_id) : null;
      res.type("html").send(createChromeHtml(session, { baseUrl, canResume, workflow, errorLogFile: errorLogLabel, artifactBase: `/artifact/${session.key}/${capFor(token, session.key)}` }));
    } catch (e) {
      next(e);
    }
  });

  app.get("/", (req, res) => {
    res.set("X-Frame-Options", "DENY");
    res.set("Content-Security-Policy", "frame-ancestors 'none'");
    res.type("html").send(createHomeHtml({ baseUrl }));
  });

  app.get("/claude", async (req, res, next) => {
    try {
      res.set("X-Frame-Options", "DENY");
      res.set("Content-Security-Policy", "frame-ancestors 'none'");
      const project = await projectFor(req.query.project);
      res.type("html").send(createLogsHtml({ baseUrl, projectKey: project?.key ?? null, errorLogFile: errorLogLabel }));
    } catch (e) {
      next(e);
    }
  });

  // D10/D13: with a registered ?project= the page has four tabs; without one, only Sessions.
  app.get("/errors", async (req, res, next) => {
    try {
      res.set("X-Frame-Options", "DENY");
      res.set("Content-Security-Policy", "frame-ancestors 'none'");
      const asked = typeof req.query.project === "string" && req.query.project !== "";
      const project = await projectFor(req.query.project);
      const recentProjects = project ? [] : (await listProjects(store, { limit: 5 })).map(projectView);
      res.type("html").send(createErrorsHtml({ baseUrl, project: project ? projectView(project) : null, recentProjects, unknownProject: asked && !project }));
    } catch (e) {
      next(e);
    }
  });

  // T6: artifact frames are sandboxed (opaque origin, so maybe no cookie): their URL carries a capability instead.
  const capOk = (req) => SESSION_KEY.test(req.params.key) && safeEqual(String(req.params.cap ?? ""), capFor(token, req.params.key));

  app.get("/artifact/:key/:cap/index.html", async (req, res, next) => {
    try {
      if (!capOk(req)) return res.status(404).json(errorBody("NOT_FOUND", "Unknown artifact"));
      const session = await store.getSession(req.params.key);
      if (!session) return res.status(404).json(errorBody("NOT_FOUND", "Unknown session"));
      let html;
      try {
        html = await fs.promises.readFile(session.file, "utf8");
      } catch {
        return res.status(404).json(errorBody("NOT_FOUND", "Artifact file missing"));
      }
      res.set("Content-Security-Policy", "sandbox allow-scripts allow-forms allow-popups; frame-ancestors 'self'");
      res.set("Cache-Control", "no-cache");
      res.type("html").send(injectSdk(withMermaid(html), session.key, session.revision));
    } catch (e) {
      next(e);
    }
  });

  // ---- M3: added outputs, under the same capability ----

  const FRAME_CSP = "sandbox allow-scripts allow-forms allow-popups; frame-ancestors 'self'";
  async function outputFor(req, res) {
    if (!capOk(req)) {
      res.status(404).json(errorBody("NOT_FOUND", "Unknown artifact"));
      return null;
    }
    const session = await store.getSession(req.params.key);
    const output = session && getOutput(session, req.params.id);
    if (!output || output.primary) {
      res.status(404).json(errorBody("NOT_FOUND", "No such output"));
      return null;
    }
    return { session, output };
  }

  app.get("/artifact/:key/:cap/o/:id/index.html", async (req, res, next) => {
    try {
      const found = await outputFor(req, res);
      if (!found) return;
      const { session, output } = found;
      const servedFile = output.kind === "markdown" ? htmlPathFor(output.file) : output.file;
      const stat = await fs.promises.stat(servedFile).catch(() => null);
      if (!stat?.isFile()) return res.status(404).json(errorBody("NOT_FOUND", "Output file missing"));
      res.set("Content-Security-Policy", FRAME_CSP);
      res.set("Cache-Control", "no-cache");
      let html;
      const limit = maxBytesFor(output.kind);
      if (stat.size > limit) html = placeholderPage(output.file, stat.size, limit);
      else if (output.kind === "image") html = renderOutputPage({ kind: "image", file: output.file, imageSrc: "__raw" });
      else {
        const text = await fs.promises.readFile(servedFile, "utf8");
        html = output.kind === "html" || output.kind === "markdown" ? withMermaid(text) : renderOutputPage({ kind: output.kind, file: output.file, text });
      }
      res.type("html").send(injectSdk(html, session.key, output.revision ?? 0));
    } catch (e) {
      next(e);
    }
  });

  // An image's bytes. The sandbox header applies even if an SVG is opened directly, so its scripts get no origin.
  app.get("/artifact/:key/:cap/o/:id/__raw", async (req, res, next) => {
    try {
      const found = await outputFor(req, res);
      if (!found) return;
      if (found.output.kind !== "image") return res.status(404).json(errorBody("NOT_FOUND", "No such asset"));
      const stat = await fs.promises.stat(found.output.file).catch(() => null);
      if (!stat?.isFile() || stat.size > maxBytesFor("image")) return res.status(404).json(errorBody("NOT_FOUND", "No such asset"));
      res.set("Content-Security-Policy", `${FRAME_CSP}; script-src 'none'`);
      res.set("Cache-Control", "no-cache");
      res.type(imageType(found.output.file)).send(await fs.promises.readFile(found.output.file));
    } catch (e) {
      next(e);
    }
  });

  // Relative assets of an added html/Markdown output resolve next to that file.
  app.get("/artifact/:key/:cap/o/:id/*splat", async (req, res, next) => {
    try {
      const found = await outputFor(req, res);
      if (!found) return;
      const rel = [].concat(req.params.splat).join("/");
      const real = await resolveArtifactAsset(path.dirname(found.output.file), rel);
      const stat = real && (await fs.promises.stat(real).catch(() => null));
      if (!stat || !stat.isFile()) return res.status(404).json(errorBody("NOT_FOUND", "No such asset"));
      res.set("Content-Security-Policy", FRAME_CSP);
      res.set("Cache-Control", "no-cache");
      res.sendFile(real, { dotfiles: "allow" }, (err) => {
        if (err && !res.headersSent) next(err);
      });
    } catch (e) {
      next(e);
    }
  });

  app.get("/artifact/:key/:cap/*splat", async (req, res, next) => {
    try {
      if (!capOk(req)) return res.status(404).json(errorBody("NOT_FOUND", "Unknown artifact"));
      const session = await store.getSession(req.params.key);
      if (!session) return res.status(404).json(errorBody("NOT_FOUND", "Unknown session"));
      const rel = [].concat(req.params.splat).join("/");
      const real = await resolveArtifactAsset(session.dir, rel);
      const stat = real && (await fs.promises.stat(real).catch(() => null));
      if (!stat || !stat.isFile()) return res.status(404).json(errorBody("NOT_FOUND", "No such asset"));
      res.set("Content-Security-Policy", "sandbox allow-scripts allow-forms allow-popups; frame-ancestors 'self'");
      res.set("Cache-Control", "no-cache");
      res.sendFile(real, { dotfiles: "allow" }, (err) => {
        if (err && !res.headersSent) next(err);
      });
    } catch (e) {
      next(e);
    }
  });

  for (const name of PUBLIC_ASSETS) {
    app.get(`/${name}`, (req, res, next) => {
      try {
        res.set("Cache-Control", "no-cache");
        res.type(CONTENT_TYPES[path.extname(name)] ?? "application/octet-stream").send(readAsset(name));
      } catch (e) {
        next(e);
      }
    });
  }

  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    log(`error: ${err?.stack ?? err}`);
    if (res.headersSent) return;
    const status = err?.status === 400 || err?.type === "entity.parse.failed" ? 400 : 500;
    res.status(status).json(errorBody(status === 400 ? "BAD_REQUEST" : "INTERNAL", err?.message));
  });

  function rejectUpgrade(socket, status, reason) {
    if (socket.writable) socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  }

  async function onUpgrade(req, socket, head) {
    socket.on("error", () => {});
    const hostHeader = req.headers.host;
    if (!hostAllowed(hostHeader)) return rejectUpgrade(socket, 403, "Forbidden");
    const origin = req.headers.origin;
    if (origin !== undefined && !sameOriginSource(req, origin)) {
      return rejectUpgrade(socket, 403, "Forbidden");
    }
    if (!authed(req)) return rejectUpgrade(socket, 401, "Unauthorized"); // T5: the cookie (or the CLI's bearer)
    let pathname;
    try {
      pathname = new URL(req.url, "http://localhost").pathname;
    } catch {
      return rejectUpgrade(socket, 404, "Not Found");
    }
    if (pathname === "/events/home") {
      if (closing) return rejectUpgrade(socket, 503, "Service Unavailable");
      return wss.handleUpgrade(req, socket, head, (ws) => onHomeConnection(ws));
    }
    const m = pathname.match(/^\/events\/([0-9a-f]{16})$/);
    const session = m && (await store.getSession(m[1]).catch(() => null));
    if (!session) return rejectUpgrade(socket, 404, "Not Found");
    if (closing) return rejectUpgrade(socket, 503, "Service Unavailable");
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, session));
  }

  function onHomeConnection(ws) {
    homeSockets.add(ws);
    updateIdle();
    ws.isAlive = true;
    ws.on("pong", () => {
      ws.isAlive = true;
    });
    ws.on("error", () => {});
    ws.on("close", () => {
      homeSockets.delete(ws);
      updateIdle();
    });
    track(homeSnapshot().then((snap) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(snap)), () => {}));
  }

  function onConnection(ws, session) {
    const { key } = session;
    watchSession(session);
    if (!sockets.has(key)) sockets.set(key, new Set());
    sockets.get(key).add(ws);
    updateIdle();
    ws.isAlive = true;
    ws.on("pong", () => {
      ws.isAlive = true;
    });
    ws.on("error", () => {});
    ws.on("close", () => {
      const set = sockets.get(key);
      set?.delete(ws);
      if (set && set.size === 0) sockets.delete(key);
      updateIdle();
    });
    ws.send(JSON.stringify(presence(key)));
    ws.send(JSON.stringify({ type: "chat", chat: serializeChat(session.chat) }));
    // Lets a (re)connecting client notice a reload it missed while disconnected.
    ws.send(JSON.stringify({ type: "revision", revision: session.revision }));
  }

  function pingAll() {
    for (const set of [...sockets.values(), homeSockets]) {
      for (const ws of set) {
        if (!ws.isAlive) {
          ws.terminate();
          continue;
        }
        ws.isAlive = false;
        ws.ping();
      }
    }
  }

  function listen() {
    return new Promise((resolve, reject) => {
      httpServer = app.listen(port, host);
      httpServer.requestTimeout = 0;
      httpServer.timeout = 0;
      httpServer.once("error", reject);
      httpServer.on("upgrade", (req, socket, head) => {
        onUpgrade(req, socket, head).catch((e) => {
          log(`upgrade error: ${e?.stack ?? e}`);
          socket.destroy();
        });
      });
      httpServer.once("listening", () => {
        const actual = httpServer.address().port;
        boundPort = actual;
        baseUrl = `http://127.0.0.1:${actual}`;
        pingTimer = setInterval(pingAll, PING_INTERVAL_MS);
        pingTimer.unref();
        updateIdle();
        // The log is one JSON array rewritten on each write: past ~1MB it should move to JSONL.
        track(errors.ready().then(
          (d) => log(d.kind === "local"
            ? `error log ${d.where}: ${d.records} records, ${d.bytes} bytes${d.bytes > 1024 * 1024 ? " (over 1MB: consider JSONL)" : ""}`
            : `error store: ${errors.label}, ${d.records} records (${d.why})${d.pending ? `, ${d.pending} waiting in the outbox` : ""}`),
          (e) => log(`error store ${errors.where}: ${e.message}`),
        ));
        resolve({ port: actual, baseUrl });
      });
    });
  }

  /**
   * S5: the one clean shutdown, shared by signals (cmdServer), POST /shutdown and the idle timeout.
   * 1. stop accepting connections; 2. answer waiting polls with { status: "waiting", reconnect: true };
   * 3. close WebSockets with 1001; 4. wait for in-flight store writes. (5 and 6, removing server.json and
   * exiting, are cmdServer's.) Emits "closed" when done.
   */
  function shutdown(reason = null) {
    if (closing) return closing;
    if (reason) log(`shutting down (${reason})`);
    closing = (async () => {
      clearInterval(pingTimer);
      clearIdle();
      for (const g of graces.values()) clearTimeout(g.timer);
      graces.clear();
      clearTimeout(homeTimer);
      const stopped = new Promise((resolve) => {
        if (!httpServer?.listening) return resolve();
        httpServer.close(() => resolve());
      });
      for (const poll of activePolls.values()) poll.notify();
      const allSockets = [...[...sockets.values()].flatMap((set) => [...set]), ...homeSockets];
      const socketsClosed = Promise.all(allSockets.map((ws) => new Promise((resolve) => {
        if (ws.readyState === ws.CLOSED) return resolve();
        ws.once("close", resolve);
        try {
          ws.close(1001, "see-plan server shutting down");
        } catch {
          resolve();
        }
      })));
      wss.close();
      await Promise.allSettled([...watchers.values()].map((w) => w.close()));
      watchers.clear();
      // Let the polls answer, then drain background work and any queued state.json writes.
      await new Promise((resolve) => setImmediate(resolve));
      while (background.size) await Promise.allSettled([...background]);
      await store.drain?.();
      await Promise.race([socketsClosed, new Promise((resolve) => setTimeout(resolve, 500).unref())]);
      for (const ws of allSockets) ws.terminate();
      httpServer?.closeAllConnections?.();
      await stopped;
      // Let socket "close" handlers run (they may restore taken feedback), then drain again.
      await new Promise((resolve) => setImmediate(resolve));
      while (background.size) await Promise.allSettled([...background]);
      await store.drain?.();
    })().then(() => events.emit("closed"));
    return closing;
  }

  const close = () => shutdown(null);

  return { app, events, listen, close, shutdown, token, authExempt };
}
