import { spawn } from "node:child_process";
import path from "node:path";

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost"]);

/** The browser launcher per platform: the URL is always one argv item, never parsed by a shell. */
export function openCommand(href, platform = process.platform) {
  if (platform === "win32") return [path.join(process.env.SystemRoot ?? "C:\\Windows", "explorer.exe"), [href]];
  if (platform === "darwin") return ["/usr/bin/open", [href]];
  return ["xdg-open", [href]];
}

/** Opens a local see-plan page in the default browser. Refuses anything but http://127.0.0.1 or http://localhost. */
export function openUrl(url, { platform = process.platform, spawnFn = spawn } = {}) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return Promise.reject(new Error(`Not a URL: ${url}`));
  }
  if (u.protocol !== "http:" || !LOCAL_HOSTS.has(u.hostname)) {
    return Promise.reject(new Error(`Refusing to open a non-local URL: ${url}`));
  }
  const [command, args] = openCommand(u.href, platform);
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnFn(command, args, { detached: true, stdio: "ignore", shell: false });
    } catch (e) {
      reject(e);
      return;
    }
    if (typeof child?.once !== "function") {
      child?.unref?.();
      resolve();
      return;
    }
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
