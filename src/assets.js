import fs from "node:fs";
import path from "node:path";
import * as nodeSea from "node:sea";
import { fileURLToPath } from "node:url";

/** The browser files the server serves. In a single-executable build they are SEA assets with these names. */
export const PUBLIC_ASSETS = ["sdk.js", "chrome-client.js", "chrome.css", "logs-client.js", "logs.css", "home-client.js", "home.css"];

export const CONTENT_TYPES = { ".js": "application/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };

/** True inside a Node single executable application. */
export function isSea(sea = nodeSea) {
  try {
    return Boolean(sea?.isSea?.());
  } catch {
    return false;
  }
}

// Resolved only when needed: inside a SEA there is no module file to resolve against.
function publicDir() {
  return fileURLToPath(new URL("../public/", import.meta.url));
}

const cache = new Map();

/** Reads public/<name> from disk, or from the SEA blob when packaged. Refuses names outside PUBLIC_ASSETS. */
export function readAsset(name, { sea = nodeSea } = {}) {
  if (!PUBLIC_ASSETS.includes(name)) throw new Error(`Not a public asset: ${name}`);
  if (isSea(sea)) {
    if (!cache.has(name)) cache.set(name, Buffer.from(sea.getAsset(name)));
    return cache.get(name);
  }
  return fs.readFileSync(path.join(publicDir(), name)); // from disk: edits show up without a restart
}

/** How the CLI starts its background server: `<node> bin/see-plan.js server`, or `<exe> server` in a SEA. */
export function serverSpawnArgs({ sea = isSea(), binPath } = {}) {
  if (sea) return ["server"];
  return [binPath ?? fileURLToPath(new URL("../bin/see-plan.js", import.meta.url)), "server"];
}
