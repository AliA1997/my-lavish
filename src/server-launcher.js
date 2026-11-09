import { spawn } from "node:child_process";
import path from "node:path";
import { LINUX_TERMINALS, OSASCRIPT_PATH, POWERSHELL_PATH, buildTmuxLaunch, expandTerminal, findTerminal, spawnChecked, whichOf } from "./claude-launcher.js";

export const SERVER_WINDOW_SETTINGS = ["auto", "window", "tmux", "hidden"];
/** S7: a terminal window can take seconds to come up (Terminal.app cold start, a PowerShell profile). */
export const WINDOW_WAIT_MS = 15000;
export const HIDDEN_WAIT_MS = 5000;

/** S3: the only variables a fresh-shell terminal gets, through an `/usr/bin/env K=V …` wrapper. */
export function allowedEnv(env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v !== "string") continue;
    if (/^(MY_LAVISH_|XDG_|SEE_PLAN_SERVER_MODE$)/.test(k) || ["CLAUDE_CONFIG_DIR", "HOME", "PATH", "LOCALAPPDATA", "APPDATA"].includes(k)) out[k] = v;
    // The Pinecone switch and where to find the key; never PINECONE_API_KEY itself (argv is visible in `ps`).
    if (["USE_PINECONE", "USE_ERROR_SEARCH", "PINECONE_API_KEY_FILE", "PINECONE_INDEX", "PINECONE_NAMESPACE", "SEE_PLAN_REPORTER"].includes(k)) out[k] = v;
  }
  return out;
}

/**
 * Picks how a server the CLI has to start is shown (S2): `window` on a desktop, `tmux` inside tmux, else
 * `hidden` (no GUI and no tmux, CI, containers). MY_LAVISH_SERVER_WINDOW / config `server_window` forces one.
 * Returns { mode, reasons }.
 */
export function chooseServerMode(environment, setting = "auto") {
  const reasons = [...(environment?.reasons ?? [])];
  const s = SERVER_WINDOW_SETTINGS.includes(setting) ? setting : "auto";
  if (setting && setting !== s) reasons.push(`unknown MY_LAVISH_SERVER_WINDOW "${setting}"`);
  if (s !== "auto") return { mode: s, reasons: [`MY_LAVISH_SERVER_WINDOW=${s}`, ...reasons] };
  if (environment?.ci || environment?.container) return { mode: "hidden", reasons };
  if (environment?.gui) return { mode: "window", reasons };
  if (environment?.tmux) return { mode: "tmux", reasons };
  return { mode: "hidden", reasons };
}

// Windows (S3, S6): a constant script; the exe, its arguments (JSON) and the title travel in env vars.
const PS_SCRIPT = [
  "$Host.UI.RawUI.WindowTitle = $env:SEE_PLAN_TITLE",
  "$a = @(ConvertFrom-Json $env:SEE_PLAN_SERVER_ARGS)",
  "& $env:SEE_PLAN_SERVER_EXE @a",
  'if ($LASTEXITCODE -ne 0) { Read-Host "see-plan server stopped with an error (exit $LASTEXITCODE). Press Enter to close" }',
].join("\n");

// macOS and Linux (S6): fixed text. The command arrives as positional "$@" arguments, never spliced in.
export const KEEP_OPEN_SH = 'printf "\\033]0;%s\\007" "$SEE_PLAN_TITLE"; "$@"; s=$?; if [ "$s" -ne 0 ]; then printf "see-plan server stopped with an error (exit %s). Press Enter to close." "$s"; read _; fi; exit "$s"';

// AppleScript reads the argv from SEE_PLAN_ARGC / SEE_PLAN_ARG_<i> and shell-quotes each item.
const OSA_LINES = [
  'set n to (system attribute "SEE_PLAN_ARGC") as integer',
  'set c to ""',
  "repeat with i from 0 to n - 1",
  '  set c to c & quoted form of (system attribute ("SEE_PLAN_ARG_" & i)) & " "',
  "end repeat",
  'tell application "Terminal" to do script c',
];

/** The POSIX argv run inside a terminal: env wrapper (allowlist), then the keep-open shell, then the server. */
export function posixServerArgv({ exe, args, env, title }) {
  const vars = Object.entries({ ...allowedEnv(env), SEE_PLAN_TITLE: title }).map(([k, v]) => `${k}=${v}`);
  return ["/usr/bin/env", ...vars, "/bin/sh", "-c", KEEP_OPEN_SH, "sh", exe, ...args];
}

/**
 * Builds the process that opens the server in its own window or tmux window (S2, S3, S6).
 * Returns { command, args, env, options } or { unavailable: reason }. No shell strings anywhere.
 */
export function buildServerLaunch({ mode, platform, exe, args, env, port, terminal = null, customTerminal = null, environment = null }) {
  const title = `see-plan server · :${port}`;
  const childEnv = { ...env, SEE_PLAN_SERVER_MODE: mode };
  if (mode === "tmux") {
    const t = buildTmuxLaunch({ argv: posixServerArgv({ exe, args, env: childEnv, title }), name: "server", cwd: process.cwd(), socket: environment?.tmux_socket ?? null, inTmux: Boolean(environment?.tmux) });
    return { command: t.command, args: t.args, env: childEnv, options: { detached: true, stdio: "ignore" }, window: t.window };
  }
  if (platform === "win32") {
    return {
      command: POWERSHELL_PATH,
      args: ["-NoLogo", "-NoProfile", "-EncodedCommand", Buffer.from(PS_SCRIPT, "utf16le").toString("base64")],
      env: { ...childEnv, SEE_PLAN_SERVER_EXE: exe, SEE_PLAN_SERVER_ARGS: JSON.stringify(args), SEE_PLAN_TITLE: title },
      // detached on Windows gives the child its own, visible console window.
      options: { detached: true, stdio: "ignore", windowsHide: false },
    };
  }
  const argv = posixServerArgv({ exe, args, env: childEnv, title });
  if (platform === "darwin") {
    const argEnv = Object.fromEntries(argv.map((a, i) => [`SEE_PLAN_ARG_${i}`, a]));
    return {
      command: OSASCRIPT_PATH,
      args: OSA_LINES.flatMap((l) => ["-e", l]),
      env: { ...env, ...argEnv, SEE_PLAN_ARGC: String(argv.length) },
      options: { detached: true, stdio: "ignore" },
    };
  }
  if (customTerminal) {
    const full = expandTerminal(customTerminal, argv);
    return { command: full[0], args: full.slice(1), env: childEnv, options: { detached: true, stdio: "ignore" } };
  }
  if (!terminal) return { unavailable: "no terminal program was found (set MY_LAVISH_TERMINAL)" };
  const name = path.basename(terminal);
  return { command: terminal, args: name === "gnome-terminal" ? ["--", ...argv] : ["-e", ...argv], env: childEnv, options: { detached: true, stdio: "ignore" } };
}

/** The Linux terminal for a server window: $TERMINAL (a bare program name) first, then the usual list. */
async function linuxTerminal(env, which) {
  if (env.TERMINAL && /^[A-Za-z0-9._/-]+$/.test(env.TERMINAL)) {
    const p = env.TERMINAL.startsWith("/") ? env.TERMINAL : await which(env.TERMINAL);
    if (p) return p;
  }
  return findTerminal({ which });
}

/**
 * Starts the server for `ensureServer` (S1-S3, S7): window or tmux when the environment allows, waiting up
 * to 15 s for /health; on a spawn error, a missing terminal or a server that never answers, the hidden start
 * once, reported as `fallback: { requested, used: "hidden", reason }`.
 */
export async function startServerProcess(ctx, {
  environment, setting = "auto", exe, args, platform = process.platform, spawnFn = spawn, startHidden,
  customTerminal = null, which = (n) => whichOf(n), windowWaitMs = WINDOW_WAIT_MS, hiddenWaitMs = HIDDEN_WAIT_MS,
}) {
  const { mode, reasons } = chooseServerMode(environment, setting);
  const hidden = async (fallback) => {
    await startHidden(ctx);
    const up = await ctx.waitUp(hiddenWaitMs);
    if (!up.conn) return { reason: up.reason };
    return { conn: up.conn, mode: "hidden", ...(fallback ? { fallback } : {}) };
  };
  if (mode === "hidden") return hidden(null);
  const terminal = mode === "window" && platform === "linux" && !customTerminal ? await linuxTerminal(ctx.env, which) : null;
  const built = buildServerLaunch({ mode, platform, exe, args, env: ctx.env, port: ctx.port, terminal, customTerminal, environment });
  if (built.unavailable) return hidden({ requested: mode, used: "hidden", reason: built.unavailable });
  const spawned = await spawnChecked(spawnFn, built.command, built.args, { ...built.options, env: built.env });
  if (!spawned.spawned) return hidden({ requested: mode, used: "hidden", reason: spawned.reason });
  const up = await ctx.waitUp(windowWaitMs);
  if (up.conn) return { conn: up.conn, mode, reasons, ...(built.window ? { window: built.window } : {}) };
  return hidden({ requested: mode, used: "hidden", reason: `the ${mode} server did not answer within ${Math.round(windowWaitMs / 1000)}s (${up.reason})` });
}

export { LINUX_TERMINALS };
