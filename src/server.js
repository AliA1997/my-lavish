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
import { appendErrorLog, ErrorLogError, reportedRecords } from "./error-log.js";
import { serializeChat } from "./markdown.js";
import { sessionKey, StoreError } from "./session-store.js";
import { ensurePlanHtml, htmlPathFor, isMarkdownPath } from "./plan-markdown.js";
import { CATEGORY_TITLES, SESSION_FEEDBACK_CATEGORIES, STAGES, STAGE_TITLES, inferStageFromText, isStage, nextStage, stageInstructions } from "./stages.js";
import { listRevisions, readRevision, saveRevision } from "./revisions.js";
import { appendFeedback } from "./feedback-log.js";
import {
  advanceWorkflow, createWorkflow, ensureStageFile, getWorkflow, isFeatureName, listWorkflows, reopenStage,
  requirementsFile, stageFile, updateStage,
} from "./workflow-store.js";
import { createHomeHtml } from "./home-page.js";
import { CONTENT_TYPES, PUBLIC_ASSETS, readAsset } from "./assets.js";
import { findLastPromptAt, findTranscript, listClaudeSessions, readTranscript } from "./claude-log.js";
import { buildPrompt, claudeStatus as realClaudeStatus, findRepoRoot, isClaudeSessionId, launchClaude as realLaunchClaude } from "./claude-launcher.js";

export { PUBLIC_ASSETS };
const ALLOWED_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);
const PING_INTERVAL_MS = 30000;
const CONNECT_COOLDOWN_MS = 60000;
export const AGENT_POLL_MS = 110000; // under Claude Code's default 120 s Bash timeout
const PRESENCE_GRACE_MS = 20000; // a re-poll within this window is invisible to the user
const LAUNCH_ERROR_STATUS = { UNSUPPORTED_PLATFORM: 501, CLAUDE_NOT_FOUND: 424 };
const STORE_ERROR_STATUS = { MISSING: 404, ENDED: 409, NOT_ENDED: 409, UNSENT_NOTES: 409, NOT_CURRENT: 409 };
const MAX_FEEDBACK_TEXT = 4000;
const LOG_ROLES = new Set(["user", "assistant"]);
const LOG_KINDS = new Set(["text", "tool_use", "tool_result"]);
const MAX_LOG_TEXT = 20000;
const MAX_REASON = 2000;
const SESSION_KEY = /^[0-9a-f]{16}$/; // sessionKey(): the first 16 hex digits of a sha256
const PAGE_LOG_BYTES = 1024 * 1024; // the log page's first window; it doubles up to PAGE_MAX_BYTES...
const PAGE_MAX_BYTES = 16 * 1024 * 1024;
const PAGE_MIN_ENTRIES = 200; // ...until it holds this many entries (screenshots make some lines huge)

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
  return typeof origin === "string" && origin === `http://${req.headers.host}`;
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
  return source !== undefined && originOf(source) !== `http://${req.headers.host}`;
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
  errorLogFile = path.join(os.homedir(), "claude-errors", "error-log.json"),
  agentPollMs = AGENT_POLL_MS,
  presenceGraceMs = PRESENCE_GRACE_MS,
  connectCooldownMs = CONNECT_COOLDOWN_MS,
}) {
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
      clearTimeout(idleTimer);
      idleTimer = null;
    } else if (!idleTimer) {
      idleTimer = setTimeout(() => {
        log(`idle for ${idleTimeoutMs} ms, shutting down`);
        close().then(() => {
          if (exitOnIdle) process.exit(0);
        });
      }, idleTimeoutMs);
      idleTimer.unref();
    }
  }

  // The log page polls over plain HTTP: each read restarts the idle countdown.
  function touchIdle() {
    clearTimeout(idleTimer);
    idleTimer = null;
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
    const ready = [watcher.ready];
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

  app.disable("x-powered-by");

  // Host allowlist: blocks DNS rebinding.
  app.use((req, res, next) => {
    if (!ALLOWED_HOSTNAMES.has(hostnameOf(req.headers.host))) {
      return res.status(403).json(errorBody("FORBIDDEN_HOST", "Host not allowed"));
    }
    next();
  });

  // Origin guard: blocks cross-site writes. Header-less (CLI) requests pass.
  app.use((req, res, next) => {
    if (req.method === "GET" || req.method === "HEAD") return next();
    const source = req.headers.origin ?? req.headers.referer;
    if (source !== undefined && originOf(source) !== `http://${req.headers.host}`) {
      return res.status(403).json(errorBody("FORBIDDEN_ORIGIN", "Cross-origin request refused"));
    }
    next();
  });

  app.use(express.json({ limit: "5mb" }));

  app.get("/health", (req, res) => {
    res.json({ ok: true, app: "my-lavish-axi", version, state_dir: stateDir });
  });

  app.post("/shutdown", (req, res) => {
    res.json({ ok: true });
    res.on("finish", () => setImmediate(() => close().catch(() => {})));
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
      let result;
      try {
        result = await store.upsertSession(real, baseUrl, { reopen: Boolean(reopen), source_file: source, stage });
      } catch (e) {
        return sendStoreError(res, e);
      }
      const { status, session } = result;
      if (status === "opened") {
        await saveRevision(stateDir, session.key, session.revision, { file: session.file, sourceFile: session.source_file }).catch(() => {});
      }
      await watchSession(session);
      notifyHome();
      res.json({ status, key: session.key, url: session.url, stage: session.stage ?? null, stage_source: session.stage_source ?? null });
    } catch (e) {
      next(e);
    }
  });

  // Sessions live in a plain object, so a key like "__proto__" must never reach the store.
  app.param("key", (req, res, next, key) => {
    if (!SESSION_KEY.test(key)) return res.status(404).json(errorBody("NOT_FOUND", "Unknown session"));
    next();
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
      let accepted;
      try {
        ({ accepted } = await store.queuePrompts(key, {
          prompts,
          dom_snapshot: typeof dom_snapshot === "string" ? dom_snapshot : "",
          end: Boolean(end),
        }));
      } catch (e) {
        return sendStoreError(res, e);
      }
      const agentNear = Boolean(activePolls.get(key)?.listening) || inGrace(key);
      if (accepted > 0) events.emit("feedback", key);
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

  app.get("/api/:key/revisions", async (req, res, next) => {
    try {
      if (isCrossSite(req)) {
        return res.status(403).json(errorBody("FORBIDDEN_ORIGIN", "Cross-origin request refused"));
      }
      const s = await store.getSession(req.params.key);
      if (!s) return res.status(404).json(errorBody("MISSING", `no session ${req.params.key}`));
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
      const html = await readRevision(stateDir, s.key, Number(req.params.n));
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

  let statusCache = null; // findClaude spawns `where`/`which`: once per process is enough
  app.get("/api/claude-status", async (req, res, next) => {
    try {
      if (isCrossSite(req)) {
        return res.status(403).json(errorBody("FORBIDDEN_ORIGIN", "Cross-origin request refused"));
      }
      statusCache ??= claudeStatus();
      res.json(await statusCache);
    } catch (e) {
      statusCache = null;
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
      res.json({ ok: true, claude_session_id: sessionId, mode, ...(launched?.command ? { command: launched.command } : {}) });
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
      res.json({ sessions: await listClaudeSessions({ claudeDir }) });
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
        const saved = await reportedRecords(errorLogFile, id); // and the page marks entries already logged
        body.reported = saved.refs;
        body.reasons = saved.reasons;
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
      const record = {
        claude_session_id: e.claude_session_id,
        uuid: e.uuid,
        part: e.part,
        role: e.role,
        kind: e.kind,
        at: e.at,
        text: e.text,
        reason: reason || null,
        reported_at: new Date().toISOString(),
      };
      let result;
      try {
        result = await appendErrorLog(errorLogFile, record);
      } catch (err) {
        if (!(err instanceof ErrorLogError)) throw err;
        return res.status(409).json(errorBody(err.code, err.message));
      }
      res.json({
        ok: true,
        status: result.duplicate ? "already_logged" : "logged",
        duplicate: result.duplicate,
        reason: result.reason, // on a duplicate, the reason saved the first time
        error_log: errorLogFile,
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
      key = sessionKey(await canonicalFile(file));
    } catch {
      return res.status(404).json({ status: "missing" });
    }
    const existing = await store.getSession(key);
    if (!existing) return res.status(404).json({ status: "missing" });
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
      res.type("html").send(createChromeHtml(session, { baseUrl, canResume, workflow }));
    } catch (e) {
      next(e);
    }
  });

  app.get("/", (req, res) => {
    res.set("X-Frame-Options", "DENY");
    res.set("Content-Security-Policy", "frame-ancestors 'none'");
    res.type("html").send(createHomeHtml({ baseUrl }));
  });

  app.get("/claude", (req, res) => {
    res.set("X-Frame-Options", "DENY");
    res.set("Content-Security-Policy", "frame-ancestors 'none'");
    res.type("html").send(createLogsHtml({ baseUrl }));
  });

  app.get("/artifact/:key/index.html", async (req, res, next) => {
    try {
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
      res.type("html").send(injectSdk(html, session.key, session.revision));
    } catch (e) {
      next(e);
    }
  });

  app.get("/artifact/:key/*splat", async (req, res, next) => {
    try {
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
    if (!ALLOWED_HOSTNAMES.has(hostnameOf(hostHeader))) return rejectUpgrade(socket, 403, "Forbidden");
    const origin = req.headers.origin;
    if (origin !== undefined && originOf(origin) !== `http://${hostHeader}`) {
      return rejectUpgrade(socket, 403, "Forbidden");
    }
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
        baseUrl = `http://127.0.0.1:${actual}`;
        pingTimer = setInterval(pingAll, PING_INTERVAL_MS);
        pingTimer.unref();
        updateIdle();
        resolve({ port: actual, baseUrl });
      });
    });
  }

  function close() {
    if (closing) return closing;
    closing = (async () => {
      clearInterval(pingTimer);
      clearTimeout(idleTimer);
      for (const g of graces.values()) clearTimeout(g.timer);
      graces.clear();
      for (const poll of activePolls.values()) poll.notify();
      clearTimeout(homeTimer);
      for (const set of sockets.values()) for (const ws of set) ws.terminate();
      for (const ws of homeSockets) ws.terminate();
      wss.close();
      await Promise.allSettled([...watchers.values()].map((w) => w.close()));
      watchers.clear();
      await new Promise((resolve) => {
        if (!httpServer) return resolve();
        httpServer.close(() => resolve());
        httpServer.closeAllConnections?.();
      });
      // Let socket "close" handlers run (they may restore taken feedback), then drain.
      await new Promise((resolve) => setImmediate(resolve));
      while (background.size) await Promise.allSettled([...background]);
    })().then(() => events.emit("closed"));
    return closing;
  }

  return { app, events, listen, close };
}
