import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Mutex } from "./async-mutex.js";
import { htmlPathFor } from "./plan-markdown.js";
import { canRelabel, inferStageFromPath, isStage, isStageSource } from "./stages.js";

const MAX_HISTORY = 10;

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
  if (p.tag === "claude-log") return "Claude log entry";
  if (p.tag === "plan") return "Whole plan";
  if (p.tag === "session-feedback") return "Session feedback";
  if (p.tag === "decision") return "Decision";
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
  #writes = 0;

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
    this.#writes++;
  }

  /** Counts this store's writes to state.json: a cache key that, unlike mtime, never repeats across quick writes. */
  get writeCount() {
    return this.#writes;
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

  /** Runs fn(state) under the store's lock; fn returns [result, dirty]. For modules that keep data in state.json. */
  transact(fn) {
    return this.#tx(fn);
  }

  #need(state, key) {
    const s = state.sessions[key];
    if (!s) throw new StoreError("MISSING", `no session ${key}`);
    return s;
  }

  upsertSession(file, baseUrl, { reopen = false, source_file, stage, workflow_id } = {}) {
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
        const inferred = inferStageFromPath(source_file ?? file);
        if (isStage(stage)) Object.assign(session, { stage, stage_source: "flag" });
        else if (inferred) Object.assign(session, { stage: inferred, stage_source: "path" });
        if (workflow_id) session.workflow_id = workflow_id;
        state.sessions[key] = session;
        return [{ status: "opened", session }, true];
      }
      if (existing.status === "ended" && existing.ended_by === "user" && !reopen) {
        return [{ status: "user-ended", session: existing }, false];
      }
      existing.url = `${baseUrl}/session/${key}`;
      if (source_file !== undefined) existing.source_file = source_file;
      if (isStage(stage)) Object.assign(existing, { stage, stage_source: "flag" });
      else {
        // Inference runs on resume too, but never over a stronger label (flag, human, text).
        const inferred = inferStageFromPath(existing.source_file ?? existing.file);
        if (inferred && canRelabel(existing.stage_source, "path")) Object.assign(existing, { stage: inferred, stage_source: "path" });
      }
      if (workflow_id) existing.workflow_id = workflow_id;
      delete existing.archived;
      if (existing.status === "ended") reopen_(existing);
      existing.updated_at = now();
      return [{ status: "resumed", session: existing }, true];
    });
  }

  getSession(key) {
    return this.#tx(async (state) => [state.sessions[key] ?? null, false]);
  }

  listSessions({ includeArchived = false } = {}) {
    return this.#tx(async (state) => [Object.values(state.sessions).filter((s) => includeArchived || !s.archived), false]);
  }

  setArchived(key, archived = true) {
    return this.#tx((state) => {
      const s = this.#need(state, key);
      if (archived) s.archived = true;
      else delete s.archived;
      s.updated_at = now();
      return [s, true];
    });
  }

  /** Removes sessions whose file no longer exists. Returns the removed { key, file } list. */
  pruneMissing({ dryRun = false, exists = (f) => fs.existsSync(f) } = {}) {
    return this.#tx((state) => {
      const removed = [];
      for (const [key, s] of Object.entries(state.sessions)) {
        if (exists(s.file)) continue;
        removed.push({ key, file: s.file });
        if (!dryRun) delete state.sessions[key];
      }
      return [removed, !dryRun && removed.length > 0];
    });
  }

  /** Sets the stage label unless a weaker source would overwrite a stronger one (human labels win over inference). */
  setStage(key, stage, source) {
    return this.#tx((state) => {
      const s = this.#need(state, key);
      if (stage !== null && !isStage(stage)) throw new StoreError("VALIDATION_ERROR", `unknown stage "${stage}"`);
      if (!isStageSource(source)) throw new StoreError("VALIDATION_ERROR", `unknown stage source "${source}"`);
      if (stage === null && source !== "human" && source !== "flag") return [{ changed: false, stage: s.stage ?? null, stage_source: s.stage_source ?? null }, false];
      if (!canRelabel(s.stage_source, source) || (s.stage === stage && s.stage_source === source)) {
        return [{ changed: false, stage: s.stage ?? null, stage_source: s.stage_source ?? null }, false];
      }
      if (stage === null) {
        delete s.stage;
        delete s.stage_source;
      } else {
        s.stage = stage;
        s.stage_source = source;
      }
      s.updated_at = now();
      return [{ changed: true, stage: s.stage ?? null, stage_source: s.stage_source ?? null }, true];
    });
  }

  /** Records an Approve / Request changes decision; approve ends the session (ended_by "approved"). */
  setDecision(key, { value, comment = "", prompt, force = false }) {
    return this.#tx((state) => {
      const s = this.#need(state, key);
      if (s.status === "ended") throw new StoreError("ENDED", "session ended");
      const unsent = s.prompts.filter((p) => p.tag !== "decision").length; // a later decision supersedes an earlier one
      if (value === "approve" && unsent && !force) {
        throw new StoreError("UNSENT_NOTES", `${unsent} note(s) have not reached the agent yet`);
      }
      const t = now();
      s.decision = { value, comment, at: t, revision: s.revision };
      if (prompt) {
        const p = cleanPrompt(prompt);
        s.chat.push({ role: "user", text: p.prompt, anchor: anchorFor(p), at: t, prompt_id: p.prompt_id });
        s.prompts.push(p);
        s.status = "feedback";
      }
      if (value === "approve") {
        s.status = "ended";
        s.ended_by = "approved";
      }
      s.updated_at = t;
      return [s, true];
    });
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
          if (dom_snapshot) s.dom_snapshot = dom_snapshot; // a log entry sends none: keep the page's last one
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

  setClaudeSession(key, id) {
    return this.#tx((state) => {
      const s = this.#need(state, key);
      s.claude_session_id = id;
      s.updated_at = now();
      return [s, true];
    });
  }

  /** Resume (keep history): leaves the ended state with the chat and Claude session kept. */
  reopenSession(key) {
    return this.#tx((state) => {
      const s = this.#need(state, key);
      if (s.status !== "ended") throw new StoreError("NOT_ENDED", "session is not ended");
      reopen_(s);
      s.updated_at = now();
      return [s, true];
    });
  }

  startNewSession(key) {
    return this.#tx((state) => {
      const s = this.#need(state, key);
      if (s.status !== "ended") throw new StoreError("NOT_ENDED", "session is not ended");
      const endedBy = s.ended_by ?? null;
      reopen_(s);
      if (s.chat.length) {
        s.history = [...(s.history ?? []), { chat: s.chat, ended_at: s.updated_at, ended_by: endedBy }].slice(-MAX_HISTORY);
      }
      delete s.decision;
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
