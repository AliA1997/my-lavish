// In-memory vector cache, numpy-style, in plain JavaScript (nothing to install on Windows or Ubuntu/WSL).
//
// How it works, in three steps:
//   1. embedText() turns a text into a fixed-length list of numbers (a "vector"): each word, and each pair of
//      neighbouring words, is hashed to one of DIMENSIONS slots and adds to that slot. Similar wording gives
//      similar vectors. Vectors are scaled to length 1, so a dot product is the cosine similarity (-1..1).
//   2. VectorCache keeps every vector as one row of a single Float32Array "matrix" (like a numpy 2-D array).
//   3. search() embeds the question and scores every row with a dot product, keeping the best topK.
//
// It matches words, not meaning: "migration" finds "migrations" but not "schema change". Pinecone's hosted
// embedding model understands meaning; this cache is the offline fallback and the local read cache.

export const DIMENSIONS = 256;

// Common words that say nothing about an error; dropping them keeps the vectors focused.
const STOP = new Set(("a an and are as at be been but by can did do does for from had has have he her his how i if in into " +
  "is it its me my no not of on or our she so than that the their them then there these they this to too us was we were what " +
  "when where which who why will with you your")
  .split(" "));

/** Lowercase words, stop words removed, with a light stem so "migrations", "migrated" and "migration" meet. */
export function tokenize(text) {
  const words = String(text ?? "").toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const out = [];
  for (let w of words) {
    if (w.length < 2 || STOP.has(w)) continue;
    if (w.length > 5 && w.endsWith("ing")) w = w.slice(0, -3);
    else if (w.length > 4 && w.endsWith("ed")) w = w.slice(0, -2);
    else if (w.length > 4 && w.endsWith("es")) w = w.slice(0, -2);
    else if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
    out.push(w);
  }
  return out;
}

/** FNV-1a: a fast, stable 32-bit hash of a string (the same word always lands in the same slot). */
function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Text -> unit-length Float32Array of `dimensions` numbers (all zeros when the text has no usable words). */
export function embedText(text, dimensions = DIMENSIONS) {
  const v = new Float32Array(dimensions);
  const words = tokenize(text);
  const add = (feature, weight) => {
    const h = hash(feature);
    v[h % dimensions] += (h & 0x80000000 ? -1 : 1) * weight; // the sign bit spreads collisions out
  };
  for (let i = 0; i < words.length; i++) {
    add(words[i], 1);
    if (i > 0) add(`${words[i - 1]} ${words[i]}`, 0.5); // word pairs keep a little word order
  }
  let norm = 0;
  for (let i = 0; i < dimensions; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < dimensions; i++) v[i] /= norm;
  return v;
}

export class VectorCache {
  constructor({ dimensions = DIMENSIONS, embed = (t) => embedText(t, dimensions), capacity = 1024 } = {}) {
    this.dimensions = dimensions;
    this.embed = embed;
    this.matrix = new Float32Array(capacity * dimensions); // row r = this.matrix[r*D .. r*D+D)
    this.ids = []; // row -> id
    this.metas = []; // row -> whatever the caller stored with the vector
    this.rowOf = new Map(); // id -> row
  }

  get size() {
    return this.ids.length;
  }

  has(id) {
    return this.rowOf.has(id);
  }

  get(id) {
    const row = this.rowOf.get(id);
    return row === undefined ? undefined : this.metas[row];
  }

  /** Adds or replaces `id`: its vector comes from `text`, and `meta` comes back with search results. */
  set(id, text, meta = null) {
    const D = this.dimensions;
    let row = this.rowOf.get(id);
    if (row === undefined) {
      row = this.ids.length;
      if ((row + 1) * D > this.matrix.length) { // full: double the matrix, like a growing numpy array
        const bigger = new Float32Array(this.matrix.length * 2);
        bigger.set(this.matrix);
        this.matrix = bigger;
      }
      this.ids.push(id);
      this.metas.push(meta);
      this.rowOf.set(id, row);
    } else {
      this.metas[row] = meta;
    }
    this.matrix.set(this.embed(text), row * D);
  }

  /** Changes what comes back with `id` without re-embedding it (for example a new severity). */
  setMeta(id, meta) {
    const row = this.rowOf.get(id);
    if (row === undefined) return false;
    this.metas[row] = meta;
    return true;
  }

  /** Removes `id` by moving the last row into its place (O(1), order is not kept). */
  delete(id) {
    const D = this.dimensions;
    const row = this.rowOf.get(id);
    if (row === undefined) return false;
    const last = this.ids.length - 1;
    if (row !== last) {
      this.matrix.copyWithin(row * D, last * D, last * D + D);
      this.ids[row] = this.ids[last];
      this.metas[row] = this.metas[last];
      this.rowOf.set(this.ids[row], row);
    }
    this.ids.pop();
    this.metas.pop();
    this.rowOf.delete(id);
    return true;
  }

  clear() {
    this.ids = [];
    this.metas = [];
    this.rowOf.clear();
  }

  /**
   * The `topK` stored texts most similar to `query`, best first: [{ id, score, meta }].
   * `filter(meta, id)` skips rows that return false. Rows scoring <= `minScore` (no shared words) are left out.
   */
  search(query, { topK = 5, filter = null, minScore = 0 } = {}) {
    const D = this.dimensions;
    const q = this.embed(query);
    const m = this.matrix;
    const best = []; // kept sorted, best first, at most topK long
    for (let row = 0; row < this.ids.length; row++) {
      if (filter && !filter(this.metas[row], this.ids[row])) continue;
      let score = 0;
      const base = row * D;
      for (let i = 0; i < D; i++) score += q[i] * m[base + i]; // dot product = cosine similarity
      if (score <= minScore) continue;
      if (best.length === topK && score <= best[best.length - 1].score) continue;
      let at = best.length;
      while (at > 0 && best[at - 1].score < score) at--;
      best.splice(at, 0, { row, score });
      if (best.length > topK) best.pop();
    }
    return best.map(({ row, score }) => ({ id: this.ids[row], score: Math.round(score * 1000) / 1000, meta: this.metas[row] }));
  }

  /** Bytes held by the vector matrix (what grows with the number of records). */
  get bytes() {
    return this.matrix.byteLength;
  }
}
