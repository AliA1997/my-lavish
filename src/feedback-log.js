import fs from "node:fs";
import path from "node:path";

let queue = Promise.resolve(); // one append at a time

/** Appends one JSON record per line to `file` (session feedback and plan decisions). */
export function appendFeedback(file, record) {
  const run = queue.then(async () => {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.appendFile(file, JSON.stringify(record) + "\n");
  });
  queue = run.catch(() => {});
  return run;
}

export async function readFeedback(file) {
  let raw;
  try {
    raw = await fs.promises.readFile(file, "utf8");
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}
