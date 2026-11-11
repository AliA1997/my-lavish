import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const system32 = (...parts) => path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", ...parts);

// Absolute paths: Node looks in cwd before PATH, so a bare name could run a planted exe.
export const POWERSHELL_PATH = system32("WindowsPowerShell", "v1.0", "powershell.exe");
export const WHERE_PATH = system32("where.exe");
export const OSASCRIPT_PATH = "/usr/bin/osascript";
/** Tried in this order on Linux; gnome-terminal takes `--`, the others `-e`. */
export const LINUX_TERMINALS = ["x-terminal-emulator", "gnome-terminal", "konsole", "xterm"];

// Constant apart from the validated UUID: the Claude path and the prompt travel in env vars.
const SCRIPT = (flag, sessionId) => `& $env:SEE_PLAN_CLAUDE ${flag} ${sessionId} $env:SEE_PLAN_PROMPT`;
// AppleScript reads every value from the environment and shell-quotes it: no path or prompt is spliced into code.
const OSA_LINES = (flag, sessionId) => [
  'set c to "cd " & quoted form of (system attribute "SEE_PLAN_CWD") & " && " & quoted form of (system attribute "SEE_PLAN_CLAUDE") & ' +
    `" ${flag} ${sessionId} " & quoted form of (system attribute "SEE_PLAN_PROMPT")`,
  'tell application "Terminal" to do script c',
  'tell application "Terminal" to activate',
];

/**
 * Args that open `script` in a new visible console. Node's `detached` on Windows means DETACHED_PROCESS, which
 * has no console at all, so a hidden PowerShell asks Start-Process for one. Both scripts are constants or a
 * validated UUID; values travel in env vars, which the new window inherits.
 */
export function windowsConsoleArgs(script, { noExit = false } = {}) {
  const inner = `${noExit ? "-NoExit " : ""}-NoLogo -NoProfile -EncodedCommand ${Buffer.from(script, "utf16le").toString("base64")}`;
  const outer = `Start-Process -FilePath '${POWERSHELL_PATH.replace(/'/g, "''")}' -ArgumentList '${inner}'`;
  return ["-NoLogo", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", Buffer.from(outer, "utf16le").toString("base64")];
}

function launchError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

export function isClaudeSessionId(id) {
  return typeof id === "string" && SESSION_ID.test(id);
}

const STAGE_TITLES = { plan: "Plan", interrogation: "Interrogation", implementation: "Implementation", verification: "Verification" };

/** `[see-plan · <feature> · <Stage>]`: Claude titles sessions by their first prompt, so the label shows in session lists. */
export function launchLabel({ file, feature, stage }) {
  const name = feature || String(file).split(/[\\/]/).pop().replace(/\.(plan\.)?(md|markdown|html?)$/i, "");
  return `[see-plan · ${name} · ${STAGE_TITLES[stage] ?? "Review"}]`;
}

export function buildPrompt({ file, feature, stage, instructions }) {
  // The raw path: Claude may run the poll in Git Bash or PowerShell, which quote differently.
  return (
    `${launchLabel({ file, feature, stage })} This is a see-plan ${stage ? `${STAGE_TITLES[stage] ?? stage} stage` : "review session"} for the file ${file}. ` +
    (instructions ? `${instructions} ` : "") +
    `Run see-plan poll on that file${stage ? ` with --stage ${stage}` : ""} (quote the path for your shell) and follow its next_step. ` +
    "The poll returns about every 1:50 with reconnect: true; run it again right away, without replying to the user. " +
    "If a permission prompt asks about see-plan, the user can allow Bash(see-plan:*) once."
  );
}

function shQuote(s) {
  return `'${String(s).replace(/'/g, "'\\''")}'`;
}

/** The command a person can paste when no terminal can be opened for them (display only, never executed by us). */
export function copyCommand({ platform, cwd, claudePath, flag, sessionId, prompt }) {
  if (platform === "win32") {
    const ps = (s) => `'${String(s).replace(/'/g, "''")}'`;
    return `Set-Location ${ps(cwd)}; & ${ps(claudePath || "claude")} ${flag} ${sessionId} ${ps(prompt)}`;
  }
  return `cd ${shQuote(cwd)} && ${shQuote(claudePath || "claude")} ${flag} ${sessionId} ${shQuote(prompt)}`;
}

/**
 * Builds the process to spawn for one platform. `resume` reuses an existing Claude session id.
 * Returns { command, args, env } or, on Linux without a known terminal, { copy: true }.
 */
export function buildClaudeLaunch({ file, sessionId, claudePath, env = process.env, platform = "win32", resume = false, cwd = ".", terminal, prompt }) {
  if (!isClaudeSessionId(sessionId)) throw launchError("VALIDATION_ERROR", "Invalid Claude session id");
  const flag = resume ? "--resume" : "--session-id";
  const text = prompt ?? buildPrompt({ file });
  if (platform === "win32") {
    return {
      command: POWERSHELL_PATH,
      args: windowsConsoleArgs(SCRIPT(flag, sessionId), { noExit: true }),
      env: { ...env, SEE_PLAN_CLAUDE: claudePath, SEE_PLAN_PROMPT: text },
    };
  }
  if (platform === "darwin") {
    return {
      command: OSASCRIPT_PATH,
      args: OSA_LINES(flag, sessionId).flatMap((l) => ["-e", l]),
      env: { ...env, SEE_PLAN_CLAUDE: claudePath, SEE_PLAN_PROMPT: text, SEE_PLAN_CWD: cwd },
    };
  }
  if (!terminal) return { copy: true };
  const run = [claudePath, flag, sessionId, text];
  const name = path.basename(terminal);
  return { command: terminal, args: name === "gnome-terminal" ? ["--", ...run] : ["-e", ...run], env: { ...env } };
}

const whereCache = new Map();

function runLookup(execFileFn, command, args) {
  return new Promise((resolve) => {
    execFileFn(command, args, { windowsHide: true }, (err, out) => resolve(err ? null : String(out)));
  });
}

/** Resolves `claude` once: prefers .exe, then .cmd, never .ps1 (blocked by the default execution policy). */
export async function findClaude({ execFileFn = execFile, platform = process.platform } = {}) {
  const cacheable = execFileFn === execFile;
  if (cacheable && whereCache.has(`claude:${platform}`)) return whereCache.get(`claude:${platform}`);
  let found = null;
  if (platform === "win32") {
    const stdout = await runLookup(execFileFn, WHERE_PATH, ["claude"]);
    if (stdout === null) return null;
    const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    found = lines.find((l) => /\.exe$/i.test(l)) ?? lines.find((l) => /\.cmd$/i.test(l)) ?? null;
    if (!found && lines.some((l) => /\.ps1$/i.test(l))) {
      throw launchError(
        "CLAUDE_NOT_FOUND",
        "Only claude.ps1 was found; PowerShell's default execution policy blocks it. Install the native Claude (claude.exe).",
      );
    }
  } else {
    found = await whichOf("claude", { execFileFn });
  }
  if (cacheable && found) whereCache.set(`claude:${platform}`, found);
  return found;
}

/** First absolute path `which` prints for `name`, or null (POSIX only). */
export async function whichOf(name, { execFileFn = execFile } = {}) {
  const stdout = await runLookup(execFileFn, "which", [name]);
  const line = stdout?.split(/\r?\n/).map((l) => l.trim()).find((l) => l.startsWith("/"));
  return line ?? null;
}

/**
 * WSL: Windows Terminal (`wt.exe`, reachable through interop) running this distro. Windows Terminal reads
 * ";" as its own command separator, so a literal one in an argument is written as \; .
 */
export function buildWslTerminalLaunch({ wt, distro, cwd, argv }) {
  const lit = (a) => String(a).replace(/;/g, "\\;");
  return { command: wt, args: ["new-tab", "wsl.exe", ...(distro ? ["-d", distro] : []), "--cd", cwd, "--", ...argv].map(lit) };
}

export async function findTerminal({ which = (n) => whichOf(n) } = {}) {
  for (const name of LINUX_TERMINALS) {
    const p = await which(name);
    if (p) return p;
  }
  return null;
}

export const LAUNCHERS = ["auto", "terminal", "tmux", "copy", "off"];
export const CMD_PLACEHOLDER = "{cmd...}";
const TMUX_SOCKET = /^\/[^\0\n]{1,200}$/;

/**
 * A custom terminal (MY_LAVISH_TERMINAL / config.json `terminal`, H3): a JSON argv array of strings with
 * exactly one "{cmd...}" placeholder, e.g. ["wezterm","start","--","{cmd...}"]. Never a shell string.
 * Returns the array, null when unset, or throws VALIDATION_ERROR.
 */
export function parseTerminalArgv(value) {
  if (value === undefined || value === null || value === "") return null;
  let argv = value;
  if (typeof value === "string") {
    try {
      argv = JSON.parse(value);
    } catch {
      throw launchError("VALIDATION_ERROR", "MY_LAVISH_TERMINAL must be a JSON array of strings, like [\"wezterm\",\"start\",\"--\",\"{cmd...}\"]");
    }
  }
  if (!Array.isArray(argv) || argv.length < 2 || !argv.every((a) => typeof a === "string" && a !== "" && !a.includes("\0"))) {
    throw launchError("VALIDATION_ERROR", "MY_LAVISH_TERMINAL must be a JSON array of at least two non-empty strings");
  }
  if (argv.filter((a) => a === CMD_PLACEHOLDER).length !== 1) {
    throw launchError("VALIDATION_ERROR", `MY_LAVISH_TERMINAL must contain "${CMD_PLACEHOLDER}" exactly once`);
  }
  if (argv[0] === CMD_PLACEHOLDER) throw launchError("VALIDATION_ERROR", "MY_LAVISH_TERMINAL must start with the terminal program");
  return argv;
}

/** Expands a custom terminal template: the placeholder becomes the command's argv items, in place. */
export function expandTerminal(template, cmdArgv) {
  return template.flatMap((a) => (a === CMD_PLACEHOLDER ? cmdArgv : [a]));
}

/** The launcher settings: env first (MY_LAVISH_LAUNCHER, MY_LAVISH_TERMINAL), then config.json. */
export function launcherSettings(env = process.env, config = {}) {
  const raw = env.MY_LAVISH_LAUNCHER || config.launcher || "auto";
  const launcher = LAUNCHERS.includes(raw) ? raw : "auto";
  let terminal = null;
  let terminalError = null;
  try {
    terminal = parseTerminalArgv(env.MY_LAVISH_TERMINAL || config.terminal);
  } catch (e) {
    terminalError = e.message;
  }
  return { launcher, terminal, terminalError, ...(launcher !== raw ? { launcherError: `unknown launcher "${raw}"` } : {}) };
}

/**
 * Picks the launch strategy (H3): the first that applies wins. `terminal` on a desktop, `tmux` inside tmux
 * (or when chosen), else `copy`. MY_LAVISH_LAUNCHER forces one; `off` hides Connect Claude.
 * Returns { strategy, reasons[] }.
 */
export function chooseStrategy(environment, settings = {}) {
  const env = environment ?? { gui: true, tmux: false, reasons: [] };
  const reasons = [...(env.reasons ?? [])];
  const launcher = LAUNCHERS.includes(settings.launcher) ? settings.launcher : "auto";
  if (settings.launcherError) reasons.push(settings.launcherError);
  if (launcher !== "auto") return { strategy: launcher, reasons: [`MY_LAVISH_LAUNCHER=${launcher}`, ...reasons] };
  if (env.gui) return { strategy: "terminal", reasons };
  if (env.tmux) return { strategy: "tmux", reasons };
  if (env.wsl && !env.remote && !env.ci) return { strategy: "terminal", reasons }; // Windows Terminal, when it is there
  return { strategy: "copy", reasons };
}

/** A tmux window name: letters, digits, dot, dash and underscore only. */
export function tmuxName(name) {
  return `see-plan-${String(name || "review").replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 40)}`;
}

/**
 * `tmux new-window -d -n <name> -c <cwd> -- <argv...>` (argv only, never a shell string). Without a tmux
 * session to target, a detached `new-session -s see-plan` instead. `socket` is the CLI's tmux server (H2).
 */
export function buildTmuxLaunch({ argv, name, cwd, socket = null, inTmux = true }) {
  const target = socket && TMUX_SOCKET.test(socket) ? ["-S", socket] : [];
  const window = tmuxName(name);
  const args = inTmux
    ? [...target, "new-window", "-d", "-n", window, "-c", cwd, "--", ...argv]
    : [...target, "new-session", "-d", "-s", "see-plan", "-n", window, "-c", cwd, "--", ...argv];
  return { command: "tmux", args, window };
}

/** What Connect Claude can do here: launch (powershell | osascript | terminal | tmux | copy | off), strategy and why. */
export async function claudeStatus({ platform = process.platform, findClaude: find = findClaude, which, environment = null, settings = {} } = {}) {
  let claudePath = null;
  try {
    claudePath = await find({ platform });
  } catch {
    claudePath = null;
  }
  const { strategy, reasons } = chooseStrategy(environment, settings);
  let launch = strategy;
  if (strategy === "terminal") {
    if (platform === "win32") launch = "powershell";
    else if (platform === "darwin") launch = "osascript";
    else if (!settings.terminal && !(await findTerminal(which ? { which } : {})) && !(environment?.wsl && await (which ?? whichOf)("wt.exe"))) launch = "copy";
  }
  const out = { platform, launch, claude_found: Boolean(claudePath), claude_path: claudePath, strategy, strategy_reasons: reasons };
  if (launch === "copy" && strategy === "terminal") out.strategy_reasons = [...reasons, "no terminal program was found (x-terminal-emulator, gnome-terminal, konsole, xterm)"];
  return out;
}

/** Nearest ancestor holding a .git entry, or `dir`. Spawns nothing. */
export async function findRepoRoot(dir) {
  let current = path.resolve(dir);
  for (;;) {
    if (await fs.promises.stat(path.join(current, ".git")).then(() => true, () => false)) return current;
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(dir);
    current = parent;
  }
}

/**
 * Starts Claude for `file` with the chosen strategy (H3). Returns { mode, strategy, strategy_reasons,
 * command?, tmux_window? }: mode is the launch kind (powershell | osascript | terminal | tmux | copy),
 * and "copy" carries a command for the user to paste.
 */
export async function launchClaude(
  { file, cwd, sessionId, resume = false, prompt, feature, environment = null, config = {} },
  { spawnFn = spawn, platform = process.platform, findClaude: find = findClaude, which } = {},
) {
  if (!["win32", "darwin", "linux"].includes(platform)) {
    throw launchError("UNSUPPORTED_PLATFORM", `Connect Claude does not support ${platform}`);
  }
  const { strategy, reasons } = chooseStrategy(environment, config);
  if (strategy === "off") throw launchError("LAUNCHER_OFF", "Connect Claude is turned off (MY_LAVISH_LAUNCHER=off)");
  const claudePath = await find({ platform });
  if (!claudePath) throw launchError("CLAUDE_NOT_FOUND", "Could not find `claude` on PATH. Install Claude Code first.");
  const text = prompt ?? buildPrompt({ file });
  const flag = resume ? "--resume" : "--session-id";
  if (!isClaudeSessionId(sessionId)) throw launchError("VALIDATION_ERROR", "Invalid Claude session id");
  const copy = (why) => ({
    mode: "copy", strategy: "copy", strategy_reasons: why ? [...reasons, why] : reasons,
    command: copyCommand({ platform, cwd, claudePath, flag, sessionId, prompt: text }),
  });
  if (strategy === "copy") return copy();
  if (strategy === "tmux") {
    const t = buildTmuxLaunch({ argv: [claudePath, flag, sessionId, text], name: feature || launchLabel({ file }).split(" · ")[1], cwd, socket: environment?.tmux_socket ?? null, inTmux: Boolean(environment?.tmux) });
    const ok = await spawnChecked(spawnFn, t.command, t.args, { cwd, env: { ...process.env }, detached: true, stdio: "ignore" });
    if (!ok.spawned) return copy(`tmux could not start: ${ok.reason}`);
    return { mode: "tmux", strategy: "tmux", strategy_reasons: reasons, tmux_window: t.window };
  }
  // terminal
  let built;
  if (platform === "linux" && config.terminal) {
    built = { command: config.terminal[0], args: expandTerminal(config.terminal, [claudePath, flag, sessionId, text]).slice(1), env: { ...process.env } };
  } else {
    const terminal = platform === "linux" ? (process.env.TERMINAL && !/[\s;&|]/.test(process.env.TERMINAL) ? await (which ?? whichOf)(process.env.TERMINAL) : null) ?? await findTerminal(which ? { which } : {}) : undefined;
    const wt = platform === "linux" && !terminal && environment?.wsl ? await (which ?? whichOf)("wt.exe") : null;
    if (wt) {
      built = { ...buildWslTerminalLaunch({ wt, distro: process.env.WSL_DISTRO_NAME, cwd, argv: [claudePath, flag, sessionId, text] }), env: { ...process.env } };
    } else {
      built = buildClaudeLaunch({ file, sessionId, claudePath, platform, resume, cwd, terminal, prompt: text });
      if (built.copy) return copy(environment?.wsl ? "no terminal was found in WSL (Windows Terminal, wt.exe, is not reachable)" : "no terminal program was found");
    }
  }
  const child = spawnFn(built.command, built.args, { cwd, env: built.env, stdio: "ignore", ...(platform === "win32" ? { windowsHide: true } : { detached: true }) });
  child.on?.("error", () => {});
  child.unref?.();
  return { mode: platform === "win32" ? "powershell" : platform === "darwin" ? "osascript" : "terminal", strategy: "terminal", strategy_reasons: reasons };
}

/** Spawns and waits for "spawn" or "error": { spawned: true } or { spawned: false, reason }. */
export function spawnChecked(spawnFn, command, args, options) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnFn(command, args, options);
    } catch (e) {
      resolve({ spawned: false, reason: e.message });
      return;
    }
    if (typeof child?.once !== "function") {
      child?.unref?.();
      resolve({ spawned: true, child });
      return;
    }
    child.once("error", (e) => resolve({ spawned: false, reason: e.code === "ENOENT" ? `${path.basename(command)} is not installed` : e.message }));
    child.once("spawn", () => {
      child.unref?.();
      resolve({ spawned: true, child });
    });
  });
}
