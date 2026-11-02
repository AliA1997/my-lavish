// Entry point of the single-executable build (bundled to CJS, so no top-level await).
// Inside a SEA, process.argv[0] and argv[1] are both the executable.
import { run } from "./cli.js";

run(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    process.stderr.write(`${e?.stack ?? e}\n`);
    process.exitCode = 1;
  },
);
