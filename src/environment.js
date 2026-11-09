import fs from "node:fs";

const MAX_ENV_HEADER = 2048;
const BOOL_KEYS = ["gui", "remote", "container", "wsl", "tmux", "ci"];
const TMUX_SOCKET = /^\/[^\0\n]{1,200}$/;
const PLATFORMS = ["win32", "darwin", "linux", "freebsd", "openbsd", "sunos", "aix"];

/**
 * What kind of place see-plan runs in (H1). Pure apart from `exists` (container marker files).
 * Returns { platform, gui, remote, container, wsl, tmux, ci, reasons[], tmux_socket }; `reasons` explain a
 * false `gui` and the other flags in words a person can act on.
 */
export function detectEnvironment({ env = process.env, platform = process.platform, exists = fs.existsSync } = {}) {
  const reasons = [];
  const ssh = Boolean(env.SSH_CONNECTION || env.SSH_TTY);
  const remote = ssh || Boolean(env.CODESPACES || env.REMOTE_CONTAINERS || env.GITPOD_WORKSPACE_ID);
  const container = platform === "linux" && (exists("/.dockerenv") || exists("/run/.containerenv") || Boolean(env.container));
  const wsl = Boolean(env.WSL_DISTRO_NAME);
  const tmux = Boolean(env.TMUX);
  const ci = Boolean(env.CI) && env.CI !== "false" && env.CI !== "0";
  let gui;
  if (platform === "win32" || platform === "darwin") {
    gui = !ssh;
    if (ssh) reasons.push("SSH_CONNECTION or SSH_TTY is set (an SSH session)");
  } else {
    gui = Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
    if (!gui) reasons.push("neither DISPLAY nor WAYLAND_DISPLAY is set");
  }
  if (ci) {
    gui = false;
    reasons.push("CI is set");
  }
  if (env.CODESPACES) reasons.push("running in GitHub Codespaces");
  if (env.REMOTE_CONTAINERS) reasons.push("running in a VS Code dev container");
  if (env.GITPOD_WORKSPACE_ID) reasons.push("running in Gitpod");
  if (container) reasons.push("running in a container");
  if (wsl) reasons.push(`running in WSL (${env.WSL_DISTRO_NAME})`);
  if (tmux) reasons.push("running inside tmux");
  const socket = tmux ? String(env.TMUX).split(",")[0] : null;
  return { platform, gui, remote, container, wsl, tmux, ci, reasons, tmux_socket: socket && TMUX_SOCKET.test(socket) ? socket : null };
}

/** A browser can be opened: a desktop, or WSL (through wslview / explorer.exe on the Windows side). */
export function canOpenBrowser(environment) {
  return Boolean(environment?.gui || (environment?.wsl && !environment?.remote && !environment?.ci));
}

/** The `X-See-Plan-Env` header value the CLI sends (H2). */
export function envHeader(environment) {
  const base = { ...Object.fromEntries(BOOL_KEYS.map((k) => [k, Boolean(environment[k])])), platform: environment.platform, tmux_socket: environment.tmux_socket ?? null };
  const value = JSON.stringify({ ...base, reasons: environment.reasons.slice(0, 8).map((r) => r.slice(0, 200)) });
  return value.length <= MAX_ENV_HEADER ? value : JSON.stringify({ ...base, reasons: [] });
}

/**
 * Parses and validates an `X-See-Plan-Env` header (H2): size-capped, booleans only, a known platform,
 * at most 8 short reasons, an absolute tmux socket path or null. Returns the environment or null.
 */
export function parseEnvHeader(raw) {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_ENV_HEADER) return null;
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const out = {};
  for (const k of BOOL_KEYS) {
    if (typeof data[k] !== "boolean") return null;
    out[k] = data[k];
  }
  if (!PLATFORMS.includes(data.platform)) return null;
  out.platform = data.platform;
  const reasons = Array.isArray(data.reasons) ? data.reasons : [];
  if (reasons.length > 8 || !reasons.every((r) => typeof r === "string" && r.length <= 200)) return null;
  out.reasons = reasons;
  const sock = data.tmux_socket ?? null;
  if (sock !== null && !(typeof sock === "string" && TMUX_SOCKET.test(sock))) return null;
  out.tmux_socket = sock;
  return out;
}
