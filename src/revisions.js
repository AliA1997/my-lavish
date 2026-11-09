import fs from "node:fs";
import path from "node:path";

export const MAX_REVISIONS = 20;
const KEY = /^[0-9a-f]{16}$/;

function dirOf(stateDir, key) {
  if (!KEY.test(key)) throw new Error("invalid session key");
  return path.join(stateDir, "revisions", key);
}

/** Copies the artifact (and its .md source, when there is one) as revision `n`; keeps the last MAX_REVISIONS. */
export async function saveRevision(stateDir, key, n, { file, sourceFile } = {}) {
  const dir = dirOf(stateDir, key);
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.copyFile(file, path.join(dir, `${n}.html`));
  if (sourceFile) await fs.promises.copyFile(sourceFile, path.join(dir, `${n}.md`)).catch(() => {});
  const all = await listRevisions(stateDir, key);
  for (const old of all.slice(0, Math.max(0, all.length - MAX_REVISIONS))) {
    await fs.promises.rm(path.join(dir, `${old.n}.html`), { force: true });
    await fs.promises.rm(path.join(dir, `${old.n}.md`), { force: true });
  }
}

/** [{ n, at, bytes }] oldest first. */
export async function listRevisions(stateDir, key) {
  const dir = dirOf(stateDir, key);
  let names;
  try {
    names = await fs.promises.readdir(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    const m = /^(\d+)\.html$/.exec(name);
    if (!m) continue;
    const st = await fs.promises.stat(path.join(dir, name)).catch(() => null);
    if (st) out.push({ n: Number(m[1]), at: st.mtime.toISOString(), bytes: st.size });
  }
  return out.sort((a, b) => a.n - b.n);
}

export async function readRevision(stateDir, key, n) {
  if (!Number.isInteger(n) || n < 0) return null;
  return fs.promises.readFile(path.join(dirOf(stateDir, key), `${n}.html`), "utf8").catch(() => null);
}

// ---- M5: added outputs keep their revisions in revisions/<key>/<output-id>/<n><ext> ----

function outputDir(stateDir, key, id) {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) throw new Error("invalid output id");
  return path.join(dirOf(stateDir, key), id);
}

async function outputFiles(dir) {
  const names = await fs.promises.readdir(dir).catch(() => []);
  return names.map((name) => ({ name, m: /^(\d+)(\.[^.]+)$/.exec(name) })).filter((x) => x.m).map((x) => ({ name: x.name, n: Number(x.m[1]) })).sort((a, b) => a.n - b.n);
}

export async function saveOutputRevision(stateDir, key, id, n, file) {
  const dir = outputDir(stateDir, key, id);
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.copyFile(file, path.join(dir, `${n}${path.extname(file).toLowerCase()}`));
  const all = await outputFiles(dir);
  for (const old of all.slice(0, Math.max(0, all.length - MAX_REVISIONS))) await fs.promises.rm(path.join(dir, old.name), { force: true });
}

export async function listOutputRevisions(stateDir, key, id) {
  const dir = outputDir(stateDir, key, id);
  const out = [];
  for (const f of await outputFiles(dir)) {
    const st = await fs.promises.stat(path.join(dir, f.name)).catch(() => null);
    if (st) out.push({ n: f.n, at: st.mtime.toISOString(), bytes: st.size });
  }
  return out;
}

/** The revision's bytes, or null. */
export async function readOutputRevision(stateDir, key, id, n) {
  if (!Number.isInteger(n) || n < 0) return null;
  const dir = outputDir(stateDir, key, id);
  const f = (await outputFiles(dir)).find((x) => x.n === n);
  return f ? fs.promises.readFile(path.join(dir, f.name)).catch(() => null) : null;
}
