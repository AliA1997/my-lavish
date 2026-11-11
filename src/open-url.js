import { spawn } from "node:child_process";
import path from "node:path";

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost"]);

/** The browser launcher per platform: the URL is always one argv item, never parsed by a shell. */
export function openCommand(href, platform = process.platform, { wsl = false } = {}) {
  if (platform === "win32") return [path.join(process.env.SystemRoot ?? "C:\\Windows", "explorer.exe"), [href]];
  if (platform === "darwin") return ["/usr/bin/open", [href]];
  if (wsl) return ["wslview", [href]];
  return ["xdg-open", [href]];
}

function trySpawn(spawnFn, command, args) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnFn(command, args, { detached: true, stdio: "ignore", shell: false });
    } catch (e) {
      resolve({ opened: false, reason: `${path.basename(command)}: ${e.message}` });
      return;
    }
    if (typeof child?.once !== "function") {
      child?.unref?.();
      resolve({ opened: true });
      return;
    }
    child.once("error", (e) => resolve({ opened: false, reason: e.code === "ENOENT" ? `${path.basename(command)} is not installed` : `${path.basename(command)}: ${e.message}` }));
    child.once("spawn", () => {
      child.unref();
      resolve({ opened: true });
    });
  });
}

/**
 * Opens a local see-plan page in the default browser (H4). Never throws: resolves to { opened: true } or
 * { opened: false, reason }. Refuses anything but http://127.0.0.1 or http://localhost.
 */
export async function openUrl(url, { platform = process.platform, spawnFn = spawn, wsl = false } = {}) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return { opened: false, reason: `not a URL: ${url}` };
  }
  if (u.protocol !== "http:" || !LOCAL_HOSTS.has(u.hostname)) {
    return { opened: false, reason: `refusing to open a non-local URL: ${url}` };
  }
  const [command, args] = openCommand(u.href, platform, { wsl });
  const first = await trySpawn(spawnFn, command, args);
  if (first.opened || !wsl) return first;
  // WSL without wslview: the Windows explorer opens the default browser. Try it on PATH (interop adds the
  // Windows folders) and then at the usual path, so a Windows folder that is not C: still works.
  const reasons = [first.reason];
  for (const exe of ["explorer.exe", "/mnt/c/Windows/explorer.exe"]) {
    const r = await trySpawn(spawnFn, exe, [u.href]);
    if (r.opened) return r;
    reasons.push(r.reason);
  }
  return { opened: false, reason: reasons.join("; ") };
}
