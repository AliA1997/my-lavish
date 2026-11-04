import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** A directory is a project root when it has one of these (D9). */
export const PROJECT_MARKERS = [".git", path.join("docs", "superpowers"), ".superpowers"];

/** Where a project's superpowers plans live, relative to its root. */
export const PLANS_DIR = path.join("docs", "superpowers", "plans");

const MAX_PLANS = 50;
const TITLE_BYTES = 4096;
const DATE_PREFIX = /^(\d{4})-(\d{2})-(\d{2})(?:[-_.]|$)/;
const PLAN_MARKDOWN = /\.(md|markdown)$/i;
const PLAN_HTML = /\.html?$/i;

const exists = (p) => fs.promises.lstat(p).then(() => true, () => false);

function samePath(a, b, platform = process.platform) {
  const norm = (p) => {
    const r = path.resolve(p);
    return platform === "win32" ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
}

async function canonicalDir(dir) {
  try {
    const real = await fs.promises.realpath(path.resolve(dir));
    return (await fs.promises.stat(real)).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

/** The home directory and the filesystem root are never projects, even with a marker (a dotfiles repo in ~). */
function isExcluded(dir, home) {
  return path.dirname(dir) === dir || (home && samePath(dir, home));
}

async function hasMarker(dir) {
  for (const m of PROJECT_MARKERS) if (await exists(path.join(dir, m))) return true;
  return false;
}

/** True when `dir` itself is a project root (D9). `dir` should already be canonical. */
export async function isProjectRoot(dir, { home = os.homedir() } = {}) {
  const real = await canonicalDir(dir);
  if (!real) return false;
  const realHome = home ? (await canonicalDir(home)) ?? path.resolve(home) : null;
  return !isExcluded(real, realHome) && hasMarker(real);
}

/**
 * The project root for `dir` (D9): the nearest directory, `dir` included, with a project marker.
 * Never the home directory or the filesystem root. Returns the canonical root, or null for a non-project directory.
 */
export async function findProjectRoot(dir, { home = os.homedir() } = {}) {
  let current = await canonicalDir(dir);
  if (!current) return null;
  const realHome = home ? (await canonicalDir(home)) ?? path.resolve(home) : null;
  for (;;) {
    if (isExcluded(current, realHome)) return null;
    if (await hasMarker(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** A display name for a project: its folder name. */
export const projectName = (root) => path.basename(root) || root;

/** The YYYY-MM-DD a file name starts with, as an ISO date at local midnight, or null. */
export function datePrefix(name) {
  const m = DATE_PREFIX.exec(name);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(y, mo - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
  return date.toISOString();
}

const titles = new Map(); // file -> { mtimeMs, title }

async function titleOf(file, mtimeMs) {
  const hit = titles.get(file);
  if (hit && hit.mtimeMs === mtimeMs) return hit.title;
  let title = "";
  try {
    const fh = await fs.promises.open(file, "r");
    try {
      const buf = Buffer.alloc(TITLE_BYTES);
      const { bytesRead } = await fh.read(buf, 0, TITLE_BYTES, 0);
      const m = /^# +(.+?)\s*#*\s*$/m.exec(buf.subarray(0, bytesRead).toString("utf8"));
      if (m) title = m[1].trim().slice(0, 200);
    } finally {
      await fh.close();
    }
  } catch {}
  if (titles.size > 2000) titles.clear(); // bound memory on very long runs
  titles.set(file, { mtimeMs, title });
  return title;
}

/**
 * The superpowers plans directly in <root>/docs/superpowers/plans (D12): Markdown files, plus HTML files not
 * generated from a sibling Markdown file. Symlinks and folders are skipped. Newest "created" first (the
 * YYYY-MM-DD name prefix, else birth time, else mtime), capped at `limit` (at most 50).
 * Returns { items: [{ name, file, title, created_at, modified_at }], total }.
 */
export async function listSuperpowersPlans(root, { limit = MAX_PLANS } = {}) {
  const dir = path.join(root, PLANS_DIR);
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (e) {
    if (e.code === "ENOENT" || e.code === "ENOTDIR") return { items: [], total: 0 };
    throw e;
  }
  const files = entries.filter((d) => d.isFile() && (PLAN_MARKDOWN.test(d.name) || PLAN_HTML.test(d.name))).map((d) => d.name);
  const stems = new Set(files.filter((n) => PLAN_MARKDOWN.test(n)).map((n) => path.parse(n).name.toLowerCase()));
  const plans = files.filter((n) => !PLAN_HTML.test(n) || !stems.has(path.parse(n).name.toLowerCase()));
  const found = (await Promise.all(plans.map(async (name) => {
    const file = path.join(dir, name);
    const st = await fs.promises.lstat(file).catch(() => null);
    if (!st?.isFile()) return null;
    const born = st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs;
    const created = datePrefix(name) ?? new Date(born).toISOString();
    return { name, file, created, born, mtimeMs: st.mtimeMs };
  }))).filter(Boolean);
  found.sort((a, b) => b.created.localeCompare(a.created) || b.born - a.born || a.name.localeCompare(b.name));
  const capped = found.slice(0, Math.min(Math.max(1, limit), MAX_PLANS));
  const items = await Promise.all(capped.map(async (p) => ({
    name: p.name,
    file: p.file,
    title: PLAN_MARKDOWN.test(p.name) ? await titleOf(p.file, p.mtimeMs) : "",
    created_at: p.created,
    modified_at: new Date(p.mtimeMs).toISOString(),
  })));
  return { items, total: Math.min(found.length, MAX_PLANS) };
}

/** A plain plan file name: no path separators, no "..", a plan extension. */
export function isPlanFileName(name) {
  return typeof name === "string" && name.length <= 255 && !/[\\/\0]/.test(name) && !name.includes("..") &&
    (PLAN_MARKDOWN.test(name) || PLAN_HTML.test(name));
}
