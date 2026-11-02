import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocketServer } from "ws";
import { watchArtifact } from "./artifact-watcher.js";
import { assertHtmlFile, canonicalFile, resolveArtifactAsset } from "./artifact-path.js";
import { injectSdk } from "./html-transform.js";
import { createChromeHtml } from "./chrome-page.js";
import { createLogsHtml } from "./logs-page.js";
import { appendErrorLog, ErrorLogError, reportedRefs } from "./error-log.js";
import { serializeChat } from "./markdown.js";
import { sessionKey, StoreError } from "./session-store.js";
import { isMarkdownPath } from "./plan-markdown.js";
import { findLastPromptAt, findTranscript, listClaudeSessions, readTranscript } from "./claude-log.js";
import { findRepoRoot, isClaudeSessionId, launchClaude as realLaunchClaude } from "./claude-launcher.js";

const PUBLIC_DIR = fileURLToPath(new URL("../public/", import.meta.url));
const ALLOWED_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);
const PING_INTERVAL_MS = 30000;
const CONNECT_COOLDOWN_MS = 60000;
const LAUNCH_ERROR_STATUS = { UNSUPPORTED_PLATFORM: 501, CLAUDE_NOT_FOUND: 424 };
const STORE_ERROR_STATUS = { MISSING: 404, ENDED: 409, NOT_ENDED: 409 };
const LOG_ROLES = new Set(["user", "assistant"]);
const LOG_KINDS = new Set(["text", "tool_use", "tool_result"]);
const MAX_LOG_TEXT = 20000;
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
  claudeDir = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"),
  errorLogFile = path.join(os.homedir(), "claude-errors", "error-log.json"),
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
  let pendingLaunch = null; // { key, at }: one launch at a time across the whole server
  const transcripts = new Map(); // Claude session id -> transcript path, for the log page

  function track(promise) {
    background.add(promise);
    promise.finally(() => background.delete(promise)).catch(() => {});
    return promise;
  }

  function broadcast(key, message) {
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

  // `working`: the last poll took feedback and no poll has listened since.
  function presence(key) {
    const a = agents.get(key);
    return {
      type: "presence",
      listening: Boolean(activePolls.get(key)?.listening),
      agent: a?.agent ?? null,
      session_id: a?.sessionId ?? null,
      working: Boolean(a?.working),
    };
  }

  async function linkClaudeSession(key, id) {
    await store.setClaudeSession(key, id);
    claudeLinks.set(key, { claudeSessionId: id, transcriptPath: null });
    broadcast(key, { type: "claude-session", id });
  }

  // Idle exit: counts down only while nothing (no WebSocket, no poll) is connected.
  function updateIdle() {
    if (closing || !httpServer || !(idleTimeoutMs > 0)) return;
    let connected = activePolls.size;
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
            (revision) => broadcast(key, { type: "reload", revision }),
            (e) => log(`revision bump failed for ${key}: ${e?.message ?? e}`),
          ),
        );
      },
      onError: (e) => log(`watcher error for ${key}: ${e?.message ?? e}`),
    });
    watchers.set(key, watcher);
    return watcher.ready;
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
      const { file, reopen, source_file: sourceFile } = req.body ?? {};
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
        result = await store.upsertSession(real, baseUrl, { reopen: Boolean(reopen), source_file: source });
      } catch (e) {
        return sendStoreError(res, e);
      }
      const { status, session } = result;
      await watchSession(session);
      res.json({ status, key: session.key, url: session.url });
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
      if (accepted > 0) events.emit("feedback", key);
      const session = await broadcastChat(key);
      if (end) {
        agents.delete(key);
        events.emit("ended", key);
        broadcast(key, { type: "ended", ended_by: "user" });
      }
      res.json({ accepted, chat: serializeChat(session?.chat ?? []) });
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
      broadcast(key, { type: "new-session" });
      res.json({ ok: true, status: session.status });
    } catch (e) {
      next(e);
    }
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
      if (activePolls.get(key)?.listening) {
        return res.status(409).json(errorBody("LISTENER_ACTIVE", "An agent is already polling this session"));
      }
      if (pendingLaunch && Date.now() - pendingLaunch.at < CONNECT_COOLDOWN_MS) {
        return res.status(409).json(errorBody("CONNECT_PENDING", "A Claude window was just started; wait for it to begin polling"));
      }
      const sessionId = crypto.randomUUID();
      const launch = { key, at: Date.now() };
      pendingLaunch = launch; // set before any await so a double click cannot start two windows
      try {
        await launchClaude({
          file: session.source_file ?? session.file,
          cwd: await findRepoRoot(session.dir),
          sessionId,
        });
      } catch (e) {
        if (pendingLaunch === launch) pendingLaunch = null;
        const status = LAUNCH_ERROR_STATUS[e?.code];
        if (!status) throw e;
        return res.status(status).json(errorBody(e.code, e.message));
      }
      await linkClaudeSession(key, sessionId);
      res.json({ ok: true, claude_session_id: sessionId });
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
        body.reported = await reportedRefs(errorLogFile, id); // and the page marks entries already logged
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
      const record = {
        claude_session_id: e.claude_session_id,
        uuid: e.uuid,
        part: e.part,
        role: e.role,
        kind: e.kind,
        at: e.at,
        text: e.text,
        reported_at: new Date().toISOString(),
      };
      let result;
      try {
        result = await appendErrorLog(errorLogFile, record);
      } catch (err) {
        if (!(err instanceof ErrorLogError)) throw err;
        return res.status(409).json(errorBody(err.code, err.message));
      }
      res.json({ ok: true, duplicate: result.duplicate, error_log: errorLogFile });
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

  async function handlePoll(req, res, { file, agent_reply: agentReply, timeoutMs: rawTimeout, agent, claude_session_id: claudeSessionId }) {
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
        if (poll.listening || poll.delivered) {
          poll.listening = false;
          broadcast(key, presence(key));
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
      if (agentReply !== undefined) {
        await store.appendAgentReply(key, agentReply);
        await broadcastChat(key);
      }

      let result = await store.takeFeedback(key);
      let timedOut = false;
      while (result.status === "waiting" && !timedOut && !vanished && !closing) {
        if (!poll.listening) {
          poll.listening = true;
          if (pendingLaunch?.key === key) pendingLaunch = null;
          agents.set(key, { agent: poll.agent, sessionId: poll.sessionId, working: false });
          broadcast(key, presence(key));
          if (timeoutMs > 0) {
            timer = setTimeout(() => {
              timedOut = true;
              notify();
            }, timeoutMs);
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
      if (result.status === "feedback" && !result.session_ended) {
        agents.set(key, { agent: poll.agent, sessionId: poll.sessionId, working: true });
        poll.delivered = true;
      }
      poll.release();
      res.json(result);
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
      res.type("html").send(createChromeHtml(session, { baseUrl }));
    } catch (e) {
      next(e);
    }
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

  for (const name of ["sdk.js", "chrome-client.js", "chrome.css", "logs-client.js", "logs.css"]) {
    app.get(`/${name}`, (req, res, next) => {
      res.set("Cache-Control", "no-cache");
      res.sendFile(name, { root: PUBLIC_DIR }, (err) => {
        if (err && !res.headersSent) next(err);
      });
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
    const m = pathname.match(/^\/events\/([0-9a-f]{16})$/);
    const session = m && (await store.getSession(m[1]).catch(() => null));
    if (!session) return rejectUpgrade(socket, 404, "Not Found");
    if (closing) return rejectUpgrade(socket, 503, "Service Unavailable");
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, session));
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
    for (const set of sockets.values()) {
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
      for (const poll of activePolls.values()) poll.notify();
      for (const set of sockets.values()) for (const ws of set) ws.terminate();
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
