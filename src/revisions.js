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
