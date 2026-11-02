import fs from "node:fs";
import path from "node:path";
import { isClaudeSessionId } from "./claude-launcher.js";

const MAX_BYTES = 256 * 1024;
const MAX_TEXT = 2000;
const NEWLINE = 0x0a;
const HEAD_BYTES = 64 * 1024;
const MAX_TITLE = 200;
const SCAN_BYTES = 16 * 1024 * 1024; // how far back the log page looks for a last prompt

const clip = (s) => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}…` : s);

/** Drops harness boilerplate; turns slash-command tags into "/name args". Returns "" if nothing is left. */
function clean(text) {
  const name = /<command-name>\s*(\S+?)\s*<\/command-name>/.exec(text);
  if (name) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text);
    return `${name[1]} ${args ? args[1].trim() : ""}`.trim();
  }
  return text
    .replace(/<(system-reminder|local-command-caveat|local-command-stdout|command-message)>[\s\S]*?<\/\1>/g, "")
    .trim();
}

/** Finds <claudeDir>/projects/*\/<sessionId>.jsonl, or null. */
export async function findTranscript(sessionId, { claudeDir }) {
  if (!isClaudeSessionId(sessionId)) return null; // never let an id become a path
  const projects = path.join(claudeDir, "projects");
  let dirs;
  try {
    dirs = await fs.promises.readdir(projects, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const candidate = path.join(projects, d.name, `${sessionId}.jsonl`);
    if ((await fs.promises.stat(candidate).catch(() => null))?.isFile()) return candidate;
  }
  return null;
}

function resultText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n");
}

/** One transcript line -> zero or more displayable entries; `uuid` + `part` name an entry for the error log. */
export function summarizeLine(obj) {
  const entries = summarizeContent(obj);
  if (typeof obj?.uuid === "string") entries.forEach((e, part) => Object.assign(e, { uuid: obj.uuid, part }));
  return entries;
}

function summarizeContent(obj) {
  if (!obj || (obj.type !== "user" && obj.type !== "assistant") || !obj.message || obj.isMeta === true) return [];
  const role = obj.type;
  const at = obj.timestamp;
  const { content } = obj.message;
  if (typeof content === "string") {
    const text = clean(content);
    return text ? [{ role, kind: "text", text: clip(text), at }] : [];
  }
  if (!Array.isArray(content)) return [];
  const entries = [];
  for (const block of content) {
    if (block?.type === "text" && typeof block.text === "string") {
      const text = clean(block.text);
      if (text) entries.push({ role, kind: "text", text: clip(text), at });
    } else if (block?.type === "tool_use") {
      entries.push({ role, kind: "tool_use", text: clip(`${block.name} ${JSON.stringify(block.input)}`), at });
    } else if (block?.type === "tool_result") {
      entries.push({ role, kind: "tool_result", text: clip(resultText(block.content)), at });
    }
  }
  return entries;
}

/**
 * Reads at most `maxBytes` of new transcript lines. `after`/`next` are byte offsets.
 * Only whole lines are consumed, so a line still being written is picked up next time.
 */
export async function readTranscript(file, { after, maxBytes = MAX_BYTES } = {}) {
  const handle = await fs.promises.open(file, "r");
  try {
    const { size } = await handle.stat();
    const tail = after === undefined || !(after <= size);
    const start = tail ? Math.max(0, size - maxBytes) : after;
    const omitted = tail && start > 0;
    const buf = Buffer.alloc(Math.min(maxBytes, size - start));
    const { bytesRead } = buf.length ? await handle.read(buf, 0, buf.length, start) : { bytesRead: 0 };
    const chunk = buf.subarray(0, bytesRead);

    let from = 0;
    if (omitted) {
      // The tail window starts mid-line: drop through the first newline.
      const nl = chunk.indexOf(NEWLINE);
      if (nl === -1) return { entries: [], next: start + bytesRead, omitted, last_prompt_at: null };
      from = nl + 1;
    }
    const last = chunk.lastIndexOf(NEWLINE);
    if (last < from) {
      // No complete line. A full chunk means one oversized line: skip it rather than stall.
      const skip = bytesRead >= maxBytes;
      return { entries: [], next: start + (skip ? bytesRead : from), omitted, last_prompt_at: null };
    }
    const entries = [];
    let lastPromptAt = null;
    for (const line of chunk.subarray(from, last).toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        const found = summarizeLine(obj);
        entries.push(...found);
        lastPromptAt = promptAt(obj, found) ?? lastPromptAt;
      } catch {
        // half-cut or corrupt line: skip it
      }
    }
    return { entries, next: start + last + 1, omitted, last_prompt_at: lastPromptAt };
  } finally {
    await handle.close();
  }
}

/** A line's timestamp when it is something the user typed: not a tool result, meta line or compact summary. */
function promptAt(obj, entries = summarizeContent(obj)) {
  const typed = obj?.type === "user" && !obj.isCompactSummary && typeof obj.timestamp === "string";
  return typed && entries.some((e) => e.kind === "text") ? obj.timestamp : null;
}

/** The last prompt's time in the first `before` bytes of a transcript, read backwards; null past `maxScan` bytes. */
export async function findLastPromptAt(file, before, { maxScan = SCAN_BYTES } = {}) {
  const handle = await fs.promises.open(file, "r");
  try {
    const stop = Math.max(0, before - maxScan);
    let pos = before;
    let carry = Buffer.alloc(0); // the head of a line the previous chunk cut off
    while (pos > stop) {
      const start = Math.max(stop, pos - MAX_BYTES);
      const buf = Buffer.alloc(pos - start);
      const { bytesRead } = await handle.read(buf, 0, buf.length, start);
      let chunk = Buffer.concat([buf.subarray(0, bytesRead), carry]);
      pos = start;
      if (start > 0) {
        // The chunk may start mid-line: keep that piece for the next (earlier) chunk.
        const nl = chunk.indexOf(NEWLINE);
        carry = chunk.subarray(0, nl === -1 ? chunk.length : nl);
        chunk = nl === -1 ? Buffer.alloc(0) : chunk.subarray(nl + 1);
      }
      const lines = chunk.toString("utf8").split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].includes('"type":"user"')) continue; // cheap filter before parsing
        try {
          const at = promptAt(JSON.parse(lines[i]));
          if (at) return at;
        } catch {
          // half-cut or corrupt line: skip it
        }
      }
    }
    return null;
  } finally {
    await handle.close();
  }
}

/**
 * cwd and a title from the first HEAD_BYTES of a transcript: a /rename title, else the first prompt.
 * Built-in commands (/clear, /model, ...) only title a session when nothing else turns up.
 */
async function readHead(file) {
  const handle = await fs.promises.open(file, "r");
  let chunk;
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(buf, 0, HEAD_BYTES, 0);
    chunk = buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
  let cwd = null;
  let custom = "";
  let prompt = "";
  let command = "";
  let lastPrompt = "";
  let afterCaveat = false;
  for (const line of chunk.toString("utf8").split("\n")) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue; // blank, or cut off at the end of the window
    }
    if (!cwd && typeof obj?.cwd === "string") cwd = obj.cwd;
    if (obj?.type === "custom-title" && typeof obj.customTitle === "string") custom = obj.customTitle;
    if (!lastPrompt && obj?.type === "last-prompt" && typeof obj.lastPrompt === "string") lastPrompt = obj.lastPrompt;
    if (obj?.type !== "user") continue;
    // A built-in command's line comes right after a meta <local-command-caveat> line; a skill's does not.
    const builtIn = afterCaveat;
    afterCaveat = obj.isMeta === true && JSON.stringify(obj.message?.content ?? "").includes("<local-command-caveat>");
    if (prompt) continue;
    const text = summarizeContent(obj).find((e) => e.role === "user" && e.kind === "text")?.text ?? "";
    if (!builtIn) prompt = text;
    else if (!command) command = text;
  }
  const title = (custom || prompt || lastPrompt || command).replace(/\s+/g, " ").trim();
  return { cwd, title: title.length > MAX_TITLE ? `${title.slice(0, MAX_TITLE)}…` : title };
}

/** The `limit` most recently written <claudeDir>/projects/*\/<uuid>.jsonl transcripts, newest first. */
export async function listClaudeSessions({ claudeDir, limit = 20 }) {
  const projects = path.join(claudeDir, "projects");
  let dirs;
  try {
    dirs = await fs.promises.readdir(projects, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = [];
  await Promise.all(dirs.filter((d) => d.isDirectory()).map(async (d) => {
    const names = await fs.promises.readdir(path.join(projects, d.name)).catch(() => []);
    await Promise.all(names.map(async (name) => {
      const id = name.slice(0, -".jsonl".length);
      if (!name.endsWith(".jsonl") || !isClaudeSessionId(id)) return;
      const file = path.join(projects, d.name, name);
      const stat = await fs.promises.stat(file).catch(() => null);
      if (stat?.isFile()) found.push({ id, project: d.name, file, mtimeMs: stat.mtimeMs });
    }));
  }));
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return Promise.all(found.slice(0, limit).map(async ({ id, project, file, mtimeMs }) => ({
    id,
    project,
    modified_at: new Date(mtimeMs).toISOString(),
    ...(await readHead(file).catch(() => ({ cwd: null, title: "" }))),
  })));
}
