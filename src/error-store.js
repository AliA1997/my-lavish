// Where error records live. One switch, read once when the server starts:
//
//   PINECONE_API_KEY is set  AND  USE_PINECONE=true   ->  PineconeErrorStore (team-shared, search by meaning)
//   anything else                                     ->  LocalErrorStore    (error-log.json on this machine)
//
// Both stores keep an in-memory VectorCache (src/vector-cache.js), so "find similar errors" always answers,
// even offline. Both expose the same methods, so server.js never asks which one it has.
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  appendErrorLog, appendedResult, duplicateResult, ErrorLogError, errorLogSize, getErrorRecord, getFrom,
  isRecord, listErrorRecords, listFrom, rateErrorRecord, ratingPatch, readErrorRecords, reportedFrom, reportedRecords,
  summarizeErrorRecords, summarizeFrom, view,
} from "./error-log.js";
import { redactSecrets } from "./redact.js";
import { isSeverity } from "./severity.js";
import { VectorCache } from "./vector-cache.js";

export const DEFAULT_INDEX = "see-plan-errors";
export const DEFAULT_NAMESPACE = "errors";
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,44}$/; // Pinecone index names: lowercase letters, digits, hyphens
const MAX_EMBED_CHARS = 6000; // stays under the embedding model's 2,048-token input
const MAX_ENTRY_CHARS = 30000; // stays under Pinecone's 40 KB of fields per record
const UPSERT_BATCH = 96; // Pinecone's limit per upsert call
const FETCH_PAGE = 100;
const REFRESH_MS = 30000; // reads use the cache; it re-checks Pinecone for teammates' changes at most this often
const FRESH_MS = 120000; // our own writes win over Pinecone for this long (Pinecone shows new writes after ~7 s)
const OVERLAP_MS = 300000; // an incremental refresh also re-reads the 5 minutes before the last change it saw

/** Same id for the same entry on every machine: err_ + 40 hex digits of sha256(session, uuid, part). */
export function recordId({ claude_session_id: sid, uuid, part }) {
  return "err_" + createHash("sha256").update(`${sid}\n${uuid}\n${Number(part) || 0}`).digest("hex").slice(0, 40);
}

/**
 * Reads the switch. Pinecone is used only when USE_PINECONE is "true" (any case) and a key is set,
 * from PINECONE_API_KEY or from the file named by PINECONE_API_KEY_FILE.
 * Returns { on, why, warn?, apiKey?, index, namespace }.
 */
export function pineconeSettings(env = process.env) {
  const index = (env.PINECONE_INDEX || DEFAULT_INDEX).trim();
  const namespace = (env.PINECONE_NAMESPACE || DEFAULT_NAMESPACE).trim();
  const base = { index, namespace };
  if (String(env.USE_PINECONE ?? "").trim().toLowerCase() !== "true") {
    return { ...base, on: false, why: "USE_PINECONE is not true" };
  }
  let apiKey = String(env.PINECONE_API_KEY ?? "").trim();
  if (!apiKey && env.PINECONE_API_KEY_FILE) {
    try {
      apiKey = fs.readFileSync(env.PINECONE_API_KEY_FILE, "utf8").trim();
    } catch {
      return { ...base, on: false, warn: true, why: `USE_PINECONE=true but PINECONE_API_KEY_FILE (${env.PINECONE_API_KEY_FILE}) could not be read` };
    }
  }
  if (!apiKey) return { ...base, on: false, warn: true, why: "USE_PINECONE=true but PINECONE_API_KEY is not set" };
  if (!NAME_RE.test(index)) return { ...base, on: false, warn: true, why: `PINECONE_INDEX "${index}" is not a valid index name (lowercase letters, digits, hyphens)` };
  return { ...base, on: true, apiKey, why: "PINECONE_API_KEY is set and USE_PINECONE=true" };
}

/** The feature flag for similar-error search: off unless USE_ERROR_SEARCH=true, or Pinecone is switched on (it needs search). */
export function errorSearchEnabled(env = process.env) {
  const on = (name) => String(env[name] ?? "").trim().toLowerCase() === "true";
  return on("USE_ERROR_SEARCH") || on("USE_PINECONE");
}

/** The text a record is searched by: what was logged, plus why it was logged. */
const searchText = (r) => `${r.text ?? ""}${r.reason ? `\n\nReason: ${r.reason}` : ""}`;

/** "plan" | "session", and severity | "unrated": the two filters both search engines understand. */
function matchesFilter(r, { context, severity } = {}) {
  const sev = isSeverity(r.severity) ? r.severity : null;
  if (context && (r.context ?? "session") !== context) return false;
  if (severity && (severity === "unrated" ? sev !== null : sev !== severity)) return false;
  return true;
}

/** Keeps a VectorCache in step with a list of records: embeds new ones, drops gone ones, refreshes the rest. */
function syncVectors(vectors, records) {
  const seen = new Set();
  for (const r of records) {
    if (!isRecord(r)) continue;
    const id = recordId(r);
    seen.add(id);
    const had = vectors.get(id);
    if (!had || had.text !== r.text || had.reason !== r.reason) vectors.set(id, searchText(r), r);
    else if (had !== r) vectors.setMeta(id, r);
  }
  if (seen.size !== vectors.size) for (const id of [...vectors.ids]) if (!seen.has(id)) vectors.delete(id);
}

function localSimilar(vectors, query, { limit = 5, context, severity } = {}, lookup) {
  const hits = vectors.search(query, { topK: limit, filter: (r) => matchesFilter(r, { context, severity }) });
  return hits.map((h) => ({ score: h.score, record: view(h.meta, lookup) }));
}

// ---------------------------------------------------------------------------------------------------------
// Local: the error-log.json file (unchanged behaviour), plus a vector cache built from it for similar search.

export class LocalErrorStore {
  constructor(file, { why = "USE_PINECONE is not true" } = {}) {
    this.kind = "local";
    this.file = file;
    this.where = file;
    this.label = file;
    this.why = why;
    this.vectors = new VectorCache();
    this.synced = null; // the records array the vectors were last built from
  }

  async ready() {
    return this.describe();
  }

  append(record) {
    return appendErrorLog(this.file, record);
  }

  rate(ref, severity, reason) {
    return rateErrorRecord(this.file, ref, severity, reason);
  }

  reported(claudeSessionId) {
    return reportedRecords(this.file, claudeSessionId);
  }

  list(opts, lookup) {
    return listErrorRecords(this.file, opts, lookup);
  }

  get(ref, lookup) {
    return getErrorRecord(this.file, ref, lookup);
  }

  summarize(lookup) {
    return summarizeErrorRecords(this.file, lookup);
  }

  /** The `limit` records most like `query`: { engine: "local", matches: [{ score, record }] }. */
  async similar(query, opts = {}, lookup) {
    const records = await readErrorRecords(this.file);
    if (records !== this.synced) { // error-log.js hands back the same array until the file changes
      syncVectors(this.vectors, records);
      this.synced = records;
    }
    return { engine: "local", matches: localSimilar(this.vectors, query, opts, lookup) };
  }

  async describe() {
    const records = await readErrorRecords(this.file).catch(() => []);
    return { kind: this.kind, where: this.where, why: this.why, records: records.length, bytes: await errorLogSize(this.file) };
  }

  close() {}
}

// ---------------------------------------------------------------------------------------------------------
// Pinecone: the team's records in a Pinecone index, read through an in-memory cache.
//
// Pinecone shows a new write to lists only after about 7 seconds, and a fetch by id right after a write is not
// guaranteed to see it. So every write goes to the cache first (write-through) and wins for FRESH_MS; reads
// answer from the cache; the cache re-reads recently changed records from Pinecone at most every REFRESH_MS.
// Writes that fail (offline) wait in an outbox file next to error-log.json and are sent on the next refresh.

/** A record -> the Pinecone document. Text is redacted first; empty fields are left out (Pinecone rejects null). */
export function toDocument(record, { reporter = null, appVersion = null, now = Date.now() } = {}) {
  const entry = redactSecrets(String(record.text ?? "")).slice(0, MAX_ENTRY_CHARS);
  const reason = typeof record.reason === "string" && record.reason ? redactSecrets(record.reason) : null;
  const doc = {
    _id: recordId(record),
    text: searchText({ text: entry, reason }).slice(0, MAX_EMBED_CHARS), // the field Pinecone embeds
    entry,
    schema: 1,
    claude_session_id: record.claude_session_id,
    uuid: record.uuid,
    part: Number(record.part) || 0,
    reported_ms: Date.parse(record.reported_at) || now,
    updated_ms: now,
  };
  const optional = {
    role: record.role, kind: record.kind, at: record.at, context: record.context, review_key: record.review_key,
    stage: record.stage, severity: isSeverity(record.severity) ? record.severity : null, reason,
    reported_at: record.reported_at, rated_at: record.rated_at, reporter, app_version: appVersion,
  };
  for (const [k, v] of Object.entries(optional)) if (v !== null && v !== undefined && v !== "") doc[k] = v;
  if (String(record.text ?? "").length > MAX_ENTRY_CHARS) doc.entry_truncated = true;
  return doc;
}

/** A Pinecone document -> the record shape error-log.json uses (missing fields come back as null). */
export function fromDocument(doc) {
  const r = {
    claude_session_id: doc.claude_session_id,
    uuid: doc.uuid,
    part: Number(doc.part) || 0,
    role: doc.role ?? null,
    kind: doc.kind ?? null,
    at: doc.at ?? null,
    text: doc.entry ?? doc.text ?? "",
    reason: doc.reason ?? null,
    severity: doc.severity ?? null,
    context: doc.context ?? "session",
    review_key: doc.review_key ?? null,
    stage: doc.stage ?? null,
    reported_at: doc.reported_at ?? new Date(doc.reported_ms ?? 0).toISOString(),
  };
  if (doc.rated_at) r.rated_at = doc.rated_at;
  if (doc.reporter) r.reporter = doc.reporter;
  return r;
}

const FIELDS = ["entry", "schema", "claude_session_id", "uuid", "part", "role", "kind", "at", "context", "review_key", "stage",
  "severity", "reason", "reported_at", "rated_at", "reported_ms", "updated_ms", "reporter"];

/** Pinecone's filter for the same context/severity choices the /errors tabs offer. */
function pineconeFilter({ context, severity } = {}) {
  const f = { schema: { $eq: 1 } };
  if (context === "plan") f.context = { $eq: "plan" };
  if (context === "session") f.context = { $ne: "plan" };
  if (severity === "unrated") f.severity = { $exists: false };
  else if (severity) f.severity = { $eq: severity };
  return f;
}

export class PineconeErrorStore {
  constructor({ client, index = DEFAULT_INDEX, namespace = DEFAULT_NAMESPACE, outboxFile = null, log = () => {},
    reporter = os.userInfo().username, appVersion = null, why = "", refreshMs = REFRESH_MS, freshMs = FRESH_MS,
    pageSize = FETCH_PAGE, createIndex = true, now = () => Date.now() }) {
    this.kind = "pinecone";
    this.client = client;
    this.indexName = index;
    this.namespace = namespace;
    this.where = `pinecone:${index}/${namespace}`;
    this.label = `Pinecone (index ${index}, namespace ${namespace})`;
    this.why = why;
    this.outboxFile = outboxFile;
    this.log = log;
    this.reporter = reporter;
    this.appVersion = appVersion;
    this.refreshMs = refreshMs;
    this.freshMs = freshMs;
    this.pageSize = pageSize;
    this.shouldCreateIndex = createIndex;
    this.now = now;
    this.idx = client.index({ name: index, namespace });
    this.records = new Map(); // id -> record (the cache every read uses)
    this.vectors = new VectorCache(); // offline fallback for similar search
    this.ownWrites = new Map(); // id -> when we wrote it (our copy wins while Pinecone catches up)
    this.loading = null; // the first full load
    this.refreshing = null;
    this.lastRefresh = 0;
    this.newestSeen = 0; // the largest updated_ms read from Pinecone, for incremental refreshes
    this.lastError = null;
    this.queue = Promise.resolve(); // one write at a time (dedupe and rate-once need it)
  }

  serialized(fn) {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => {});
    return run;
  }

  put(record) {
    const id = recordId(record);
    this.records.set(id, record);
    this.vectors.set(id, searchText(record), record);
    return id;
  }

  isFresh(id) {
    const t = this.ownWrites.get(id);
    if (t === undefined) return false;
    if (this.now() - t < this.freshMs) return true;
    this.ownWrites.delete(id);
    return false;
  }

  /** Creates the index when it is missing (serverless, aws us-east-1, Pinecone embeds `text`), then waits for it. */
  async ensureIndex() {
    if (!this.shouldCreateIndex) return;
    await this.client.createIndex({
      name: this.indexName,
      schema: { fields: { text: { type: "string", embed: {} } } },
      deployment: { deploymentType: "managed", cloud: "aws", region: "us-east-1" },
      tags: { app: "see-plan" },
      waitUntilReady: true,
      timeout: 240000,
      suppressConflicts: true,
    });
  }

  /** Every document matching `filter`, page by page. */
  async fetchAll(filter) {
    const out = [];
    let token;
    do {
      const page = await this.idx.documents.fetch({ filter, includeFields: FIELDS, limit: this.pageSize, ...(token ? { paginationToken: token } : {}) });
      out.push(...Object.values(page.documents ?? {}));
      token = page.pagination?.next;
    } while (token);
    return out;
  }

  /** First call: create the index if needed and read every record. Later calls: recent changes only. */
  async refresh() {
    const full = this.lastRefresh === 0;
    if (full) await this.ensureIndex();
    await this.flushOutbox();
    const filter = full ? { schema: { $eq: 1 } } : { updated_ms: { $gte: this.newestSeen - OVERLAP_MS } };
    const docs = await this.fetchAll(filter);
    for (const d of docs) {
      if (typeof d.updated_ms === "number" && d.updated_ms > this.newestSeen) this.newestSeen = d.updated_ms;
      if (!d.claude_session_id || !d.uuid || this.isFresh(d._id)) continue;
      this.put(fromDocument(d));
    }
    this.lastRefresh = this.now();
    this.lastError = null;
  }

  /** Waits for the first load; afterwards starts a background refresh when the cache is older than refreshMs. */
  async ensureLoaded() {
    if (!this.loading) {
      this.loading = this.refresh().catch((e) => {
        this.loading = null;
        this.lastError = e.message;
        throw new ErrorLogError(`Pinecone could not be read (${e.message}); check the network and PINECONE_API_KEY, or unset USE_PINECONE to use the local file`);
      });
    }
    await this.loading;
    if (!this.refreshing && this.now() - this.lastRefresh > this.refreshMs) {
      this.refreshing = this.refresh()
        .catch((e) => {
          this.lastError = e.message;
          this.log(`pinecone refresh failed: ${e.message} (serving the cache)`);
        })
        .finally(() => { this.refreshing = null; });
    }
  }

  async ready() {
    await this.ensureLoaded();
    return this.describe();
  }

  /** Waits for a background refresh in progress (tests and benchmarks use it). */
  async settle() {
    await this.refreshing;
    await this.queue;
  }

  async snapshot() {
    await this.ensureLoaded();
    return [...this.records.values()];
  }

  // ---- the outbox: writes that could not reach Pinecone, sent again on the next refresh ----

  readOutbox() {
    if (!this.outboxFile) return this.memoryOutbox ?? [];
    try {
      const ops = JSON.parse(fs.readFileSync(this.outboxFile, "utf8"));
      return Array.isArray(ops) ? ops : [];
    } catch {
      return [];
    }
  }

  writeOutbox(ops) {
    if (!this.outboxFile) {
      this.memoryOutbox = ops;
      return;
    }
    if (!ops.length) {
      fs.rmSync(this.outboxFile, { force: true });
      return;
    }
    fs.mkdirSync(path.dirname(this.outboxFile), { recursive: true });
    const tmp = `${this.outboxFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(ops, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, this.outboxFile);
  }

  enqueue(op, err) {
    this.writeOutbox([...this.readOutbox(), op]);
    this.lastError = err.message;
    this.log(`pinecone write failed (${err.message}); queued in the outbox, sent again on the next refresh`);
  }

  /** Sends queued writes in order; stops at the first failure and keeps the rest. */
  async flushOutbox() {
    const ops = this.readOutbox();
    let done = 0;
    try {
      while (done < ops.length) {
        if (ops[done].op === "upsert") {
          let end = done;
          while (end < ops.length && ops[end].op === "upsert" && end - done < UPSERT_BATCH) end++;
          await this.idx.documents.upsert({ documents: ops.slice(done, end).map((o) => o.doc) });
          done = end;
        } else {
          await this.idx.documents.update({ documents: [ops[done].doc] });
          done++;
        }
      }
    } finally {
      if (done) this.writeOutbox(ops.slice(done));
    }
  }

  pending() {
    return this.readOutbox().length;
  }

  // ---- the same methods as LocalErrorStore ----

  /** Asks Pinecone for one record by id; null when it is not there or Pinecone cannot be reached. */
  async fetchOne(id) {
    try {
      const doc = (await this.idx.documents.fetch({ ids: [id], includeFields: FIELDS })).documents?.[id];
      return doc?.claude_session_id ? fromDocument(doc) : null;
    } catch {
      return null;
    }
  }

  append(record) {
    return this.serialized(async () => {
      await this.ensureLoaded();
      const id = recordId(record);
      let saved = this.records.get(id);
      if (!saved) { // logged from another machine, and not in our cache yet?
        saved = await this.fetchOne(id);
        if (saved) this.put(saved);
      }
      if (saved) return duplicateResult(saved);
      const doc = toDocument(record, { reporter: this.reporter, appVersion: this.appVersion, now: this.now() });
      this.put({ ...record, reporter: this.reporter });
      this.ownWrites.set(id, this.now());
      try {
        await this.idx.documents.upsert({ documents: [doc] });
      } catch (e) {
        this.enqueue({ op: "upsert", doc }, e);
      }
      return appendedResult(record);
    });
  }

  rate(ref, severity, reason) {
    return this.serialized(async () => {
      await this.ensureLoaded();
      const id = recordId(ref);
      let saved = this.records.get(id);
      if (!saved) {
        saved = await this.fetchOne(id);
        if (saved) this.put(saved);
      }
      const patch = ratingPatch(saved, severity, reason); // MISSING, ALREADY_RATED, VALIDATION_ERROR
      const updated = { ...saved, ...patch };
      this.put(updated);
      this.ownWrites.set(id, this.now());
      // update merges fields; an upsert would replace the whole document (spike, 2026-11-08).
      const fields = { _id: id, severity: patch.severity, rated_at: patch.rated_at, updated_ms: this.now(), ...(patch.reason ? { reason: redactSecrets(patch.reason) } : {}) };
      try {
        await this.idx.documents.update({ documents: [fields] });
      } catch (e) {
        this.enqueue({ op: "update", doc: fields }, e);
      }
      return { severity: updated.severity, reason: typeof updated.reason === "string" ? updated.reason : null };
    });
  }

  async reported(claudeSessionId) {
    return reportedFrom(await this.snapshot().catch(() => []), claudeSessionId);
  }

  async list(opts, lookup) {
    return listFrom(await this.snapshot(), opts, lookup);
  }

  async get(ref, lookup) {
    return getFrom(await this.snapshot(), ref, lookup);
  }

  async summarize(lookup) {
    return summarizeFrom(await this.snapshot(), lookup);
  }

  /**
   * The `limit` records closest in meaning to `query`, from Pinecone's embedding model.
   * When Pinecone cannot be reached, the local vector cache answers instead ({ engine: "local", fallback }).
   */
  async similar(query, { limit = 5, context, severity } = {}, lookup) {
    let loadError = null;
    await this.ensureLoaded().catch((e) => { loadError = e; });
    try {
      if (loadError) throw loadError;
      const res = await this.idx.documents.search({
        topK: limit,
        scoreBy: [{ type: "embed", field: "text", query: String(query).slice(0, MAX_EMBED_CHARS) }],
        filter: pineconeFilter({ context, severity }),
        includeFields: FIELDS,
      });
      const matches = (res.matches ?? []).map((m) => ({
        score: Math.round((m._score ?? 0) * 1000) / 1000,
        record: view(this.records.get(m._id) ?? fromDocument(m), lookup),
      }));
      return { engine: "pinecone", matches };
    } catch (e) {
      return { engine: "local", fallback: e.message, matches: localSimilar(this.vectors, query, { limit, context, severity }, lookup) };
    }
  }

  async describe() {
    return {
      kind: this.kind, where: this.where, why: this.why, index: this.indexName, namespace: this.namespace,
      records: this.records.size, pending: this.pending(),
      last_refresh: this.lastRefresh ? new Date(this.lastRefresh).toISOString() : null,
      ...(this.lastError ? { last_error: this.lastError } : {}),
    };
  }

  close() {}
}

/**
 * Picks the store from the environment (see the top of this file). `client` replaces the Pinecone SDK in tests.
 * Logs which store it chose, and why, without ever logging the key.
 */
export async function createErrorStore({ file, env = process.env, log = () => {}, client = null, appVersion = null } = {}) {
  const s = pineconeSettings(env);
  if (!s.on) {
    if (s.warn) log(`warning: ${s.why}; error records stay in ${file}`);
    return new LocalErrorStore(file, { why: s.why });
  }
  let pc = client;
  if (!pc) {
    const { Pinecone } = await import("@pinecone-database/pinecone");
    pc = new Pinecone({ apiKey: s.apiKey });
  }
  return new PineconeErrorStore({
    client: pc, index: s.index, namespace: s.namespace, why: s.why, log, appVersion,
    outboxFile: path.join(path.dirname(file), "pinecone-outbox.json"),
    reporter: env.SEE_PLAN_REPORTER || os.userInfo().username,
  });
}
