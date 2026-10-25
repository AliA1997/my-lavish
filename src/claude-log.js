import fs from "node:fs";
import path from "node:path";
import { isClaudeSessionId } from "./claude-launcher.js";

const MAX_BYTES = 256 * 1024;
const MAX_TEXT = 2000;
const NEWLINE = 0x0a;

const clip = (s) => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}…` : s);

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

/** One transcript line -> zero or more displayable entries. */
export function summarizeLine(obj) {
  if (!obj || (obj.type !== "user" && obj.type !== "assistant") || !obj.message || obj.isMeta === true) return [];
  const role = obj.type;
  const at = obj.timestamp;
  const { content } = obj.message;
  if (typeof content === "string") return [{ role, kind: "text", text: clip(content), at }];
  if (!Array.isArray(content)) return [];
  const entries = [];
  for (const block of content) {
    if (block?.type === "text" && typeof block.text === "string") {
      entries.push({ role, kind: "text", text: clip(block.text), at });
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
      if (nl === -1) return { entries: [], next: start + bytesRead, omitted };
      from = nl + 1;
    }
    const last = chunk.lastIndexOf(NEWLINE);
    if (last < from) {
      // No complete line. A full chunk means one oversized line: skip it rather than stall.
      const skip = bytesRead >= maxBytes;
      return { entries: [], next: start + (skip ? bytesRead : from), omitted };
    }
    const entries = [];
    for (const line of chunk.subarray(from, last).toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        entries.push(...summarizeLine(JSON.parse(line)));
      } catch {
        // half-cut or corrupt line: skip it
      }
    }
    return { entries, next: start + last + 1, omitted };
  } finally {
    await handle.close();
  }
}
