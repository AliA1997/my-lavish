import fs from "node:fs";
import path from "node:path";
import { isSeverity, needsReason, SEVERITIES, worseSeverity } from "./severity.js";

export class ErrorLogError extends Error {
  constructor(message, code = "ERROR_LOG_UNREADABLE") {
    super(message);
    this.code = code;
  }
}

let queue = Promise.resolve(); // one write at a time: two quick clicks must not drop a record
const cache = new Map(); // file -> { mtimeMs, size, gen, records }: the parsed log, until the file changes
let gen = 0; // bumped on every write, so a read that raced a write never caches what it saw

const refOf = (r) => `${r.uuid}:${Number(r.part) || 0}`;
export const isRecord = (r) => r !== null && typeof r === "object" && typeof r.uuid === "string" && typeof r.claude_session_id === "string";
const severityOf = (r) => (isSeverity(r.severity) ? r.severity : null);
const UNCLASSIFIED = { context: "session", review_key: null, stage: null };

/** The parsed records in `file` ([] when it is missing), cached until the file changes. */
export async function readErrorRecords(file) {
  return readRecords(file);
}

async function readRecords(file) {
  let stat;
  try {
    stat = await fs.promises.stat(file);
  } catch (e) {
    if (e.code === "ENOENT") {
      cache.delete(file);
      return [];
    }
    throw e;
  }
  const hit = cache.get(file);
  if (hit && hit.gen === gen && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.records;
  const started = gen;
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
  if (started === gen) cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, gen, records });
  return records;
}

async function writeRecords(file, records) {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify(records, null, 2) + "\n");
  await fs.promises.rename(tmp, file); // a crash mid-write never leaves a half-written log
}

export function findRecord(records, { claude_session_id: id, uuid, part }) {
  const ref = refOf({ uuid, part });
  return records.find((r) => isRecord(r) && r.claude_session_id === id && refOf(r) === ref);
}

function serialized(fn) {
  const run = queue.then(fn);
  queue = run.catch(() => {});
  return run;
}

async function append(file, record) {
  const records = await readRecords(file);
  const saved = findRecord(records, record);
  if (saved) {
    return duplicateResult(saved);
  }
  try {
    await writeRecords(file, [...records, record]);
  } finally {
    gen++;
    cache.delete(file);
  }
  return appendedResult(record);
}

/** Appends `record` to the JSON array in `file` (created if missing); a record already there is skipped. */
export function appendErrorLog(file, record) {
  return serialized(() => append(file, record));
}

/**
 * D6: gives an Unrated record a severity, once. A reason may be added when the record has none,
 * and must be for High and Send to IT. Fails with MISSING, ALREADY_RATED or VALIDATION_ERROR.
 */
export function rateErrorRecord(file, ref, severity, reason) {
  return serialized(async () => {
    if (!isSeverity(severity)) throw new ErrorLogError(`severity must be one of ${SEVERITIES.join(", ")}`, "VALIDATION_ERROR");
    const records = await readRecords(file);
    const saved = findRecord(records, ref);
    const patch = ratingPatch(saved, severity, reason);
    const updated = records.map((r) => (r === saved ? { ...r, ...patch } : r));
    try {
      await writeRecords(file, updated);
    } finally {
      gen++;
      cache.delete(file);
    }
    const out = updated.find((r) => findRecord([r], ref));
    return { severity: out.severity, reason: typeof out.reason === "string" ? out.reason : null };
  });
}

/**
 * D6 as a pure rule, shared by every store: the fields to add to `saved` when it is rated now.
 * Throws MISSING, ALREADY_RATED or VALIDATION_ERROR.
 */
export function ratingPatch(saved, severity, reason) {
  if (!isSeverity(severity)) throw new ErrorLogError(`severity must be one of ${SEVERITIES.join(", ")}`, "VALIDATION_ERROR");
  if (!saved) throw new ErrorLogError("No such error record", "MISSING");
  if (severityOf(saved)) throw new ErrorLogError("This record already has a severity", "ALREADY_RATED");
  const hasReason = typeof saved.reason === "string" && saved.reason.trim() !== "";
  const extra = typeof reason === "string" ? reason.trim() : "";
  if (needsReason(severity) && !hasReason && !extra) throw new ErrorLogError("High and Send to IT need a reason", "VALIDATION_ERROR");
  return { severity, ...(hasReason || !extra ? {} : { reason: extra }), rated_at: new Date().toISOString() };
}

/** What appending a record returns when `saved` is already there (the first reason and severity are kept). */
export function duplicateResult(saved) {
  return { duplicate: true, reason: typeof saved.reason === "string" ? saved.reason : null, severity: severityOf(saved) };
}

/** What appending a new `record` returns. */
export function appendedResult(record) {
  return { duplicate: false, reason: record.reason ?? null, severity: severityOf(record) };
}

/**
 * The records of one Claude session, so the page can mark entries already logged:
 * `refs` lists "<uuid>:<part>", `reasons` maps a ref to its saved reason (only refs that have one),
 * and `severities` maps a ref to its severity (only rated refs).
 */
export async function reportedRecords(file, claudeSessionId) {
  return reportedFrom(await readRecords(file).catch(() => []), claudeSessionId);
}

/** reportedRecords over records already in memory. */
export function reportedFrom(records, claudeSessionId) {
  const mine = records.filter((r) => isRecord(r) && r.claude_session_id === claudeSessionId);
  const reasons = Object.create(null);
  const severities = Object.create(null);
  for (const r of mine) {
    const ref = refOf(r);
    if (typeof r.reason === "string" && r.reason && !(ref in reasons)) reasons[ref] = r.reason;
    if (severityOf(r) && !(ref in severities)) severities[ref] = r.severity;
  }
  return { refs: mine.map(refOf), reasons, severities };
}

/** A record's context, review key and stage: stored at log time, or (records before 0.3.0) worked out now. */
function classified(r, lookup) {
  if (r.context === "plan" || r.context === "session") {
    return { context: r.context, review_key: r.review_key ?? null, stage: r.stage ?? null };
  }
  return lookup?.get(r.claude_session_id) ?? UNCLASSIFIED;
}

export function view(r, lookup) {
  return { ...r, ...classified(r, lookup), severity: severityOf(r), reason: typeof r.reason === "string" && r.reason ? r.reason : null };
}

/** Newest first: by reported_at, then by position (a later append wins a tie). */
function newestFirst(records) {
  return records
    .map((r, i) => ({ r, i, t: Date.parse(r.reported_at) || 0 }))
    .sort((a, b) => b.t - a.t || b.i - a.i)
    .map((x) => x.r);
}

/** One page of records, newest first, filtered by context and severity ("unrated" = no severity). */
export async function listErrorRecords(file, opts, lookup) {
  return listFrom(await readRecords(file), opts, lookup);
}

/** listErrorRecords over records already in memory. */
export function listFrom(all, { context, severity, limit = 50, offset = 0 } = {}, lookup) {
  const records = all.filter(isRecord);
  const matching = newestFirst(records)
    .map((r) => view(r, lookup))
    .filter((r) => (!context || r.context === context)
      && (!severity || (severity === "unrated" ? r.severity === null : r.severity === severity)));
  const items = matching.slice(offset, offset + limit);
  const end = offset + items.length;
  return { items, total: matching.length, next_offset: end < matching.length ? end : null };
}

/** One record, classified, or null. */
export async function getErrorRecord(file, ref, lookup) {
  return getFrom(await readRecords(file), ref, lookup);
}

/** getErrorRecord over records already in memory. */
export function getFrom(records, ref, lookup) {
  const saved = findRecord(records, ref);
  return saved ? view(saved, lookup) : null;
}

const emptyCounts = () => ({ all: 0, low: 0, medium: 0, high: 0, send_to_it: 0, unrated: 0 });

function bump(map, k, severity) {
  if (!k) return;
  const cur = map.get(k) ?? { count: 0, worst: null };
  cur.count += 1;
  cur.worst = worseSeverity(cur.worst, severity);
  map.set(k, cur);
}

/**
 * Every count the /errors page needs, in one pass: `counts[context][severity|"unrated"|"all"]`,
 * plus `bySession` (Claude session id) and `byReview` (review key) maps of { count, worst }.
 */
export async function summarizeErrorRecords(file, lookup) {
  return summarizeFrom(await readRecords(file), lookup);
}

/** summarizeErrorRecords over records already in memory. */
export function summarizeFrom(all, lookup) {
  const records = all.filter(isRecord);
  const counts = { session: emptyCounts(), plan: emptyCounts() };
  const bySession = new Map();
  const byReview = new Map();
  for (const r of records) {
    const { context, review_key: reviewKey } = classified(r, lookup);
    const severity = severityOf(r);
    const c = counts[context];
    c.all += 1;
    c[severity ?? "unrated"] += 1;
    bump(bySession, r.claude_session_id, severity);
    bump(byReview, reviewKey, severity);
  }
  return { counts, bySession, byReview };
}

/** The error log's size in bytes, or 0 when it does not exist yet. */
export async function errorLogSize(file) {
  return (await fs.promises.stat(file).catch(() => null))?.size ?? 0;
}
