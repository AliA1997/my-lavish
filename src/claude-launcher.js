import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const system32 = (...parts) => path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", ...parts);

// Absolute paths: Node looks in cwd before PATH, so a bare name could run a planted exe.
export const POWERSHELL_PATH = system32("WindowsPowerShell", "v1.0", "powershell.exe");
export const WHERE_PATH = system32("where.exe");

// Constant apart from the validated UUID: the Claude path and the prompt travel in env vars.
const SCRIPT = (sessionId) => `& $env:SEE_PLAN_CLAUDE --session-id ${sessionId} $env:SEE_PLAN_PROMPT`;

function launchError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

export function isClaudeSessionId(id) {
  return typeof id === "string" && SESSION_ID.test(id);
}

export function buildClaudeLaunch({ file, sessionId, claudePath, env = process.env }) {
  if (!isClaudeSessionId(sessionId)) throw launchError("VALIDATION_ERROR", "Invalid Claude session id");
  // The raw path: Claude may run the poll in Git Bash or PowerShell, which quote differently.
  const prompt =
    `This is a see-plan review session for the file ${file}. ` +
    "Run see-plan poll on that file (quote the path for your shell) and follow its next_step.";
  return {
    command: POWERSHELL_PATH,
    args: ["-NoExit", "-EncodedCommand", Buffer.from(SCRIPT(sessionId), "utf16le").toString("base64")],
    env: { ...env, SEE_PLAN_CLAUDE: claudePath, SEE_PLAN_PROMPT: prompt },
  };
}

let cachedClaude = null;

/** Resolves `claude` once: prefers .exe, then .cmd, never .ps1 (blocked by the default execution policy). */
export async function findClaude({ execFileFn = execFile } = {}) {
  if (execFileFn === execFile && cachedClaude) return cachedClaude;
  const stdout = await new Promise((resolve) => {
    execFileFn(WHERE_PATH, ["claude"], { windowsHide: true }, (err, out) => resolve(err ? null : String(out)));
  });
  if (stdout === null) return null;
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const found = lines.find((l) => /\.exe$/i.test(l)) ?? lines.find((l) => /\.cmd$/i.test(l));
  if (!found) {
    if (lines.some((l) => /\.ps1$/i.test(l))) {
      throw launchError(
        "CLAUDE_NOT_FOUND",
        "Only claude.ps1 was found; PowerShell's default execution policy blocks it. Install the native Claude (claude.exe).",
      );
    }
    return null;
  }
  if (execFileFn === execFile) cachedClaude = found;
  return found;
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

export async function launchClaude(
  { file, cwd, sessionId },
  { spawnFn = spawn, platform = process.platform, findClaude: find = findClaude } = {},
) {
  if (platform !== "win32") throw launchError("UNSUPPORTED_PLATFORM", "Connect Claude is only supported on Windows");
  const claudePath = await find();
  if (!claudePath) throw launchError("CLAUDE_NOT_FOUND", "Could not find `claude` on PATH. Install Claude Code first.");
  const { command, args, env } = buildClaudeLaunch({ file, sessionId, claudePath });
  const child = spawnFn(command, args, { cwd, env, detached: true, stdio: "ignore" });
  child.on?.("error", () => {});
  child.unref();
}
