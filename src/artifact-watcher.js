import crypto from "node:crypto";
import fs from "node:fs";
import chokidar from "chokidar";

export const POLL_MS = 400;

async function statKey(file) {
  try {
    const s = await fs.promises.stat(file);
    return `${s.mtimeMs}:${s.size}:${s.ino}`;
  } catch {
    return null;
  }
}

async function contentHash(file) {
  return crypto.createHash("sha1").update(await fs.promises.readFile(file)).digest("hex");
}

/**
 * Watches one artifact file and calls onChange() once per new content.
 *
 * chokidar is the fast path. A low-frequency stat poll is the backstop for events chokidar
 * loses: on Windows, when `git checkout` replaces a singly-watched file, chokidar can emit
 * `unlink`, switch to watching the parent directory, and miss the file's return (no `add`).
 * Every trigger only re-hashes the content, so identical content never bumps twice.
 */
export function watchArtifact(file, { onChange, onError = () => {}, pollMs = POLL_MS }) {
  let closed = false;
  let lastHash = null;
  let seen = null; // stat key at the last poll tick
  let checked = null; // stat key whose content was last hashed
  // Hashes the file; resolves to null when it is missing or busy mid-replace (the poll retries).
  const fingerprint = async () => {
    const st = await statKey(file);
    if (st === null) return null;
    try {
      return { st, hash: await contentHash(file) };
    } catch {
      return null;
    }
  };

  // The baseline: the content the session already shows.
  const init = fingerprint().then((fp) => {
    if (!fp) return;
    lastHash = fp.hash;
    checked = seen = fp.st;
  });
  let chain = init;

  // Serialized: re-hash the file and report a change when the content differs.
  const check = () => {
    chain = chain.then(async () => {
      if (closed) return;
      const fp = await fingerprint();
      if (!fp || closed) return;
      checked = seen = fp.st;
      if (fp.hash === lastHash) return;
      lastHash = fp.hash;
      onChange();
    }).catch((e) => onError(e));
    return chain;
  };

  const watcher = chokidar.watch(file, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
  });
  watcher.on("change", check);
  watcher.on("add", check);
  watcher.on("unlink", check); // usually a replace: the new content may already be there

  let ticking = false;
  const timer = setInterval(async () => {
    if (ticking || closed) return;
    ticking = true;
    try {
      const st = await statKey(file);
      if (closed) return;
      if (st !== seen) {
        seen = st; // changed since the last tick: wait one tick for it to settle
        return;
      }
      if (st !== null && st !== checked) await check();
    } finally {
      ticking = false;
    }
  }, pollMs);
  timer.unref();

  const ready = Promise.all([
    init,
    new Promise((resolve) => {
      watcher.once("ready", resolve);
      watcher.on("error", (e) => {
        onError(e);
        resolve();
      });
    }),
  ]).then(() => {});

  return {
    ready,
    async close() {
      closed = true;
      clearInterval(timer);
      await watcher.close();
      await chain;
    },
  };
}
