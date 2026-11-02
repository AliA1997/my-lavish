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
  const name = feature || path.basename(String(file)).replace(/\.(plan\.)?(md|markdown|html?)$/i, "");
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
      args: ["-NoExit", "-EncodedCommand", Buffer.from(SCRIPT(flag, sessionId), "utf16le").toString("base64")],
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

export async function findTerminal({ which = (n) => whichOf(n) } = {}) {
  for (const name of LINUX_TERMINALS) {
    const p = await which(name);
    if (p) return p;
  }
  return null;
}

/** What Connect Claude can do on this machine: powershell | osascript | terminal | copy. */
export async function claudeStatus({ platform = process.platform, findClaude: find = findClaude, which } = {}) {
  let claudePath = null;
  try {
    claudePath = await find({ platform });
  } catch {
    claudePath = null;
  }
  let launch = "copy";
  if (platform === "win32") launch = "powershell";
  else if (platform === "darwin") launch = "osascript";
  else if (await findTerminal(which ? { which } : {})) launch = "terminal";
  return { platform, launch, claude_found: Boolean(claudePath), claude_path: claudePath };
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
 * Opens a terminal running Claude for `file`. Returns { mode, command? }: mode is the launch kind,
 * or "copy" with a command for the user to paste when no terminal can be opened.
 */
export async function launchClaude(
  { file, cwd, sessionId, resume = false, prompt },
  { spawnFn = spawn, platform = process.platform, findClaude: find = findClaude, which } = {},
) {
  if (!["win32", "darwin", "linux"].includes(platform)) {
    throw launchError("UNSUPPORTED_PLATFORM", `Connect Claude does not support ${platform}`);
  }
  const claudePath = await find({ platform });
  if (!claudePath) throw launchError("CLAUDE_NOT_FOUND", "Could not find `claude` on PATH. Install Claude Code first.");
  const text = prompt ?? buildPrompt({ file });
  const flag = resume ? "--resume" : "--session-id";
  const terminal = platform === "linux" ? await findTerminal(which ? { which } : {}) : undefined;
  const built = buildClaudeLaunch({ file, sessionId, claudePath, platform, resume, cwd, terminal, prompt: text });
  if (built.copy) {
    return { mode: "copy", command: copyCommand({ platform, cwd, claudePath, flag, sessionId, prompt: text }) };
  }
  const child = spawnFn(built.command, built.args, { cwd, env: built.env, detached: true, stdio: "ignore" });
  child.on?.("error", () => {});
  child.unref?.();
  return { mode: platform === "win32" ? "powershell" : platform === "darwin" ? "osascript" : "terminal" };
}
