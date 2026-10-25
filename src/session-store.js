import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Mutex } from "./async-mutex.js";
import { htmlPathFor } from "./plan-markdown.js";

export function sessionKey(file) {
  return crypto.createHash("sha256").update(file).digest("hex").slice(0, 16);
}

export class StoreError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.name = "StoreError";
    this.code = code;
  }
}

const now = () => new Date().toISOString();

function anchorFor(p) {
  if (p.tag === "text") return "text selection";
  if (p.tag === "chat") return "";
  return `${p.tag} ${p.selector}`;
}

function cleanPrompt(p) {
  const out = { prompt_id: p.prompt_id, prompt: p.prompt, tag: p.tag, selector: p.selector, text: p.text };
  if (p.target !== undefined) out.target = p.target;
  return out;
}

// Leaves the ended state; undelivered prompts keep the session in "feedback".
function reopen_(s) {
  s.status = s.prompts.length ? "feedback" : "open";
  delete s.ended_by;
}

export class SessionStore {
  #file;
  #dir;
  #mutex = new Mutex();

  constructor(stateDir) {
    this.#dir = stateDir;
    this.#file = path.join(stateDir, "state.json");
  }

  async #read() {
    try {
      const data = JSON.parse(await fs.promises.readFile(this.#file, "utf8"));
      if (data && typeof data.sessions === "object" && data.sessions !== null) return data;
    } catch {}
    return { version: 1, sessions: {} };
  }

  async #write(state) {
    await fs.promises.mkdir(this.#dir, { recursive: true });
    const tmp = `${this.#file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify(state, null, 2));
    await fs.promises.rename(tmp, this.#file);
  }

  // Runs fn(state) under the mutex; fn returns [result, dirty].
  #tx(fn) {
    return this.#mutex.runExclusive(async () => {
      const state = await this.#read();
      const [result, dirty] = await fn(state);
      if (dirty) await this.#write(state);
      return result;
    });
  }

  #need(state, key) {
    const s = state.sessions[key];
    if (!s) throw new StoreError("MISSING", `no session ${key}`);
    return s;
  }

  upsertSession(file, baseUrl, { reopen = false, source_file } = {}) {
    return this.#tx((state) => {
      if (source_file !== undefined && htmlPathFor(source_file) !== file) {
        throw new StoreError("VALIDATION_ERROR", "source_file must be the Markdown source of file");
      }
      const key = sessionKey(file);
      const existing = state.sessions[key];
      if (!existing) {
        const t = now();
        const session = {
          key, file, dir: path.dirname(file), url: `${baseUrl}/session/${key}`,
          status: "open", prompts: [], dom_snapshot: "", chat: [], revision: 0,
          created_at: t, updated_at: t,
        };
        if (source_file !== undefined) session.source_file = source_file;
        state.sessions[key] = session;
        return [{ status: "opened", session }, true];
      }
      if (existing.status === "ended" && existing.ended_by === "user" && !reopen) {
        return [{ status: "user-ended", session: existing }, false];
      }
      existing.url = `${baseUrl}/session/${key}`;
      if (source_file !== undefined) existing.source_file = source_file;
      if (existing.status === "ended") reopen_(existing);
      existing.updated_at = now();
      return [{ status: "resumed", session: existing }, true];
    });
  }

  getSession(key) {
    return this.#tx(async (state) => [state.sessions[key] ?? null, false]);
  }

  listSessions() {
    return this.#tx(async (state) => [Object.values(state.sessions), false]);
  }

  queuePrompts(key, { prompts, dom_snapshot = "", end = false }, { restore = false } = {}) {
    return this.#tx((state) => {
      const s = this.#need(state, key);
      if (s.status === "ended" && !restore) throw new StoreError("ENDED", "session ended");
      const t = now();
      const seen = new Set((restore ? s.prompts : s.chat).map((x) => x.prompt_id));
      const accepted = [];
      for (const p of prompts) {
        if (seen.has(p.prompt_id)) continue;
        seen.add(p.prompt_id);
        accepted.push(cleanPrompt(p));
      }
      if (restore) {
        s.prompts = [...accepted, ...s.prompts];
        if (accepted.length && !s.dom_snapshot) s.dom_snapshot = dom_snapshot;
        if (accepted.length && s.status !== "ended") s.status = "feedback";
      } else {
        for (const p of accepted) {
          s.chat.push({ role: "user", text: p.prompt, anchor: anchorFor(p), at: t, prompt_id: p.prompt_id });
        }
        s.prompts.push(...accepted);
        if (accepted.length) {
          s.dom_snapshot = dom_snapshot;
          s.status = "feedback";
        }
        if (end) {
          s.status = "ended";
          s.ended_by = "user";
        }
      }
      s.updated_at = t;
      return [{ accepted: accepted.length }, true];
    });
  }

  takeFeedback(key) {
    return this.#tx((state) => {
      const s = state.sessions[key];
      if (!s) return [{ status: "missing" }, false];
      if (s.prompts.length === 0) {
        if (s.status === "ended") return [{ status: "ended", ended_by: s.ended_by }, false];
        return [{ status: "waiting" }, false];
      }
      const out = { status: "feedback", prompts: s.prompts, dom_snapshot: s.dom_snapshot };
      s.prompts = [];
      s.dom_snapshot = "";
      if (s.status === "ended") {
        out.session_ended = true;
        out.ended_by = s.ended_by;
      } else {
        s.status = "open";
      }
      s.updated_at = now();
      return [out, true];
    });
  }

  appendAgentReply(key, text) {
    return this.#tx((state) => {
      const s = this.#need(state, key);
      const entry = { role: "agent", text, at: now() };
      s.chat.push(entry);
      s.updated_at = entry.at;
      return [entry, true];
    });
  }

  endSession(key, endedBy) {
    return this.#tx((state) => {
      const s = this.#need(state, key);
      s.status = "ended";
      s.ended_by = endedBy;
      s.updated_at = now();
      return [s, true];
    });
  }

  startNewSession(key) {
    return this.#tx((state) => {
      const s = this.#need(state, key);
      if (s.status !== "ended") throw new StoreError("NOT_ENDED", "session is not ended");
      reopen_(s);
      s.chat = [];
      delete s.claude_session_id;
      s.updated_at = now();
      return [s, true];
    });
  }

  bumpRevision(key) {
    return this.#tx((state) => {
      const s = this.#need(state, key);
      s.revision += 1;
      s.updated_at = now();
      return [s.revision, true];
    });
  }
}
