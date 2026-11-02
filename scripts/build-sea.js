#!/usr/bin/env node
// Builds dist/see-plan[.exe]: a Node single executable application (SEA) with every public/ file as an asset.
//   1. write src/version.js   2. bundle to dist/see-plan.cjs (esbuild, CJS)   3. write sea-config.json
//   4. node --experimental-sea-config   5. copy this node binary   6. inject the blob (postject)
//   7. write dist/THIRD_PARTY_LICENSES.txt (dependencies + Node.js)
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { inject } from "postject";
import { PUBLIC_ASSETS } from "../src/assets.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");
const FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";
const exeName = process.platform === "win32" ? "see-plan.exe" : "see-plan";
const exe = path.join(DIST, exeName);
const bundle = path.join(DIST, "see-plan.cjs");
const blob = path.join(DIST, "sea-prep.blob");
const configFile = path.join(DIST, "sea-config.json");

function step(msg) {
  console.log(`build-sea: ${msg}`);
}

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });

step("version");
execFileSync(process.execPath, [path.join(ROOT, "scripts", "write-version.js")], { stdio: "inherit" });

step("bundle");
await build({
  entryPoints: [path.join(ROOT, "src", "sea-main.js")],
  outfile: bundle,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  // ws loads these optional native helpers inside try/catch; a SEA can only require built-ins.
  external: ["bufferutil", "utf-8-validate"],
  // import.meta does not exist in CJS. Paths built from it are only used outside a SEA.
  define: { "import.meta.url": "__seePlanModuleUrl" },
  banner: {
    js: 'var __seePlanModuleUrl = require("node:url").pathToFileURL(typeof __filename === "string" ? __filename : process.execPath).href;',
  },
  legalComments: "eof",
  logLevel: "warning",
});

step("sea-config.json");
const assets = Object.fromEntries(PUBLIC_ASSETS.map((name) => [name, path.join(ROOT, "public", name)]));
fs.writeFileSync(configFile, JSON.stringify({
  main: bundle,
  output: blob,
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: false,
  assets,
}, null, 2));

step("blob");
execFileSync(process.execPath, ["--experimental-sea-config", configFile], { stdio: "inherit", cwd: ROOT });

step(`copy ${process.execPath}`);
fs.copyFileSync(process.execPath, exe);
fs.chmodSync(exe, 0o755);
if (process.platform === "darwin") execFileSync("codesign", ["--remove-signature", exe], { stdio: "inherit" });

step("inject");
await inject(exe, "NODE_SEA_BLOB", fs.readFileSync(blob), {
  sentinelFuse: FUSE,
  ...(process.platform === "darwin" ? { machoSegmentName: "NODE_SEA" } : {}),
});
if (process.platform === "darwin") execFileSync("codesign", ["--sign", "-", exe], { stdio: "inherit" });

step("third-party licenses");
execFileSync(process.execPath, [path.join(ROOT, "scripts", "third-party-licenses.js"), "--out", path.join(DIST, "THIRD_PARTY_LICENSES.txt"), "--node"], { stdio: "inherit", cwd: ROOT });

for (const f of [blob, configFile]) fs.rmSync(f, { force: true });
const size = (fs.statSync(exe).size / 1024 / 1024).toFixed(1);
step(`done: ${path.relative(ROOT, exe)} (${size} MB, Node ${process.version})`);
