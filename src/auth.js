import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RUNTIME_FILE } from "./paths.js";

/** Absolute path, as the launcher does: Node looks in cwd before PATH, so a bare name could run a planted exe. */
export const ICACLS_PATH = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe");
export const NONCE_TTL_MS = 60000;
const CAP_HEX = 32;

/** 32 random bytes, base64url (T2). A new one on every server start; never stored in state.json, never logged. */
export function createToken() {
  return crypto.randomBytes(32).toString("base64url");
}

export const BROWSER_KEY_FILE = "browser-key";
/** How long a signed-in browser stays signed in, restarts included (30 days). */
export const COOKIE_MAX_AGE_S = 30 * 24 * 3600;

/**
 * The browser's long-lived secret: read from `<dir>/browser-key`, or made and saved there (mode 0600, a
 * user-only ACL on Windows). The cookie is derived from it, so a signed-in browser stays signed in across
 * server restarts instead of landing on the sign-in screen. The CLI token is still new on every start. If
 * the file cannot be written, a one-start key is returned and the old behaviour applies.
 */
export async function loadBrowserKey(dir, { platform = process.platform, execFileFn } = {}) {
  const file = path.join(dir, BROWSER_KEY_FILE);
  try {
    const v = (await fs.promises.readFile(file, "utf8")).trim();
    if (/^[A-Za-z0-9_-]{43}$/.test(v)) return v;
  } catch {}
  const key = createToken();
  try {
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    await fs.promises.writeFile(tmp, key, { mode: 0o600 });
    if (platform === "win32") await icacls(tmp, { execFileFn });
    await renameWithRetry(tmp, file);
  } catch {}
  return key;
}

/** Timing-safe string compare. Different lengths are false without comparing contents. */
export function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

const hmac = (token, data) => crypto.createHmac("sha256", token).update(data).digest("hex");

/** The capability for one session's artifact frame (T6): HMAC-SHA256(token, key), 32 hex digits. */
export function capFor(token, key) {
  return hmac(token, `artifact:${key}`).slice(0, CAP_HEX);
}

/** The browser cookie value: derived from the token, so it is useless once the server restarts. */
export function cookieValueFor(token) {
  return hmac(token, "cookie");
}

/** The cookie name includes the port: 127.0.0.1 cookies are shared across ports. */
export function cookieNameFor(port) {
  return `see_plan_${port}`;
}

/** Parses a Cookie header into a Map (last value wins). */
export function parseCookies(header) {
  const out = new Map();
  if (typeof header !== "string") return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  return out;
}

/** The bearer token of an Authorization header, or null. */
export function bearerOf(header) {
  if (typeof header !== "string") return null;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return m ? m[1] : null;
}

/**
 * Single-use login nonces (T4): the CLI asks for one with its bearer token, the browser trades it for the cookie.
 * Kept in memory only, so they die with the server.
 */
export function createNonceStore({ ttlMs = NONCE_TTL_MS, now = Date.now } = {}) {
  const nonces = new Map();
  const sweep = () => {
    const t = now();
    for (const [n, exp] of nonces) if (exp <= t) nonces.delete(n);
  };
  return {
    issue() {
      sweep();
      const n = crypto.randomBytes(24).toString("base64url");
      nonces.set(n, now() + ttlMs);
      return n;
    },
    /** True once per nonce, and only before it expires. */
    consume(n) {
      if (typeof n !== "string" || !nonces.has(n)) return false;
      const exp = nonces.get(n);
      nonces.delete(n);
      return exp > now();
    },
    get size() {
      sweep();
      return nonces.size;
    },
  };
}

/** A same-origin relative path for `/auth?next=`: refuses absolute URLs, `//host` and backslash tricks. */
export function safeNext(next) {
  if (typeof next !== "string" || next === "") return "/";
  if (next.length > 2048 || !next.startsWith("/") || next.startsWith("//") || next.includes("\\") || /[\u0000-\u001f]/.test(next)) return null;
  try {
    const u = new URL(next, "http://127.0.0.1");
    if (u.origin !== "http://127.0.0.1") return null;
    return u.pathname + u.search + u.hash;
  } catch {
    return null;
  }
}

function icacls(file, { execFileFn = execFile, user = os.userInfo().username } = {}) {
  return new Promise((resolve) => {
    execFileFn(ICACLS_PATH, [file, "/inheritance:r", "/grant:r", `${user}:F`], { windowsHide: true }, (err) => resolve(err ? err.message : null));
  });
}

/** Windows refuses to rename over a file another process has open (a CLI reading it); that clears in moments. */
async function renameWithRetry(from, to, tries = 40) {
  for (let i = 1; ; i++) {
    try {
      return await fs.promises.rename(from, to);
    } catch (e) {
      if (i >= tries || !["EPERM", "EACCES", "EBUSY"].includes(e.code)) {
        await fs.promises.rm(from, { force: true }).catch(() => {});
        throw e;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
  }
}

/**
 * Writes the runtime file atomically (temp file + rename) with mode 0600 in a 0700 folder on POSIX (T2).
 * On Windows the file also gets a user-only ACL through icacls (Q3); a failure is returned as a warning.
 */
export async function writeRuntimeFile(dir, data, { platform = process.platform, execFileFn } = {}) {
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  if (platform !== "win32") await fs.promises.chmod(dir, 0o700).catch(() => {});
  const file = path.join(dir, RUNTIME_FILE);
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  let warning = null;
  if (platform === "win32") warning = await icacls(tmp, { execFileFn });
  await renameWithRetry(tmp, file);
  return { file, warning };
}

/** True when a process with this pid exists (EPERM means it exists but belongs to someone else). */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

/**
 * Reads the runtime file: { ok: true, data } or { ok: false, reason } where reason is
 * missing | unreadable | stale (the pid is gone, or it is for another port).
 */
export async function readRuntimeFile(dir, { port, alive = pidAlive } = {}) {
  let text;
  try {
    text = await fs.promises.readFile(path.join(dir, RUNTIME_FILE), "utf8");
  } catch (e) {
    return { ok: false, reason: e.code === "ENOENT" ? "missing" : "unreadable", message: e.message };
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, reason: "unreadable", message: "not JSON" };
  }
  if (!data || typeof data.token !== "string" || !Number.isInteger(data.port)) return { ok: false, reason: "unreadable", message: "missing fields" };
  if (port !== undefined && port !== 0 && data.port !== port) return { ok: false, reason: "stale", message: `for port ${data.port}`, data };
  if (!alive(data.pid)) return { ok: false, reason: "stale", message: `pid ${data.pid} is gone`, data };
  return { ok: true, data };
}

/** Deletes the runtime file only while it still holds this pid (S5): a newer server's file is never removed. */
export async function removeRuntimeFile(dir, pid = process.pid) {
  const file = path.join(dir, RUNTIME_FILE);
  try {
    const data = JSON.parse(await fs.promises.readFile(file, "utf8"));
    if (data?.pid !== pid) return false;
    await fs.promises.rm(file, { force: true });
    return true;
  } catch {
    return false;
  }
}
