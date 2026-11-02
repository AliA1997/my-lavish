import fs from "node:fs";
import path from "node:path";

export class ErrorLogError extends Error {
  constructor(message) {
    super(message);
    this.code = "ERROR_LOG_UNREADABLE";
  }
}

let queue = Promise.resolve(); // one write at a time: two quick clicks must not drop a record

const refOf = (r) => `${r.uuid}:${Number(r.part) || 0}`;

async function readRecords(file) {
  let raw;
  try {
    raw = await fs.promises.readFile(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
  let records;
  try {
    records = JSON.parse(raw);
  } catch {
    records = null;
  }
  if (!Array.isArray(records)) throw new ErrorLogError(`${file} is not a JSON array; fix or move it, then retry`);
  return records;
}

async function append(file, record) {
  const records = await readRecords(file);
  const ref = refOf(record);
  if (records.some((r) => r?.claude_session_id === record.claude_session_id && typeof r.uuid === "string" && refOf(r) === ref)) {
    return { duplicate: true };
  }
  records.push(record);
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify(records, null, 2) + "\n");
  await fs.promises.rename(tmp, file); // a crash mid-write never leaves a half-written log
  return { duplicate: false };
}

/** Appends `record` to the JSON array in `file` (created if missing); a record already there is skipped. */
export function appendErrorLog(file, record) {
  const run = queue.then(() => append(file, record));
  queue = run.catch(() => {});
  return run;
}

/** "<uuid>:<part>" for each record of one Claude session, so the page can mark entries already logged. */
export async function reportedRefs(file, claudeSessionId) {
  const records = await readRecords(file).catch(() => []);
  return records.filter((r) => r?.claude_session_id === claudeSessionId && typeof r.uuid === "string").map(refOf);
}
