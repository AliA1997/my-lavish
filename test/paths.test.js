import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pathRows, readConfig, resolvePaths } from "../src/paths.js";

const none = () => false;
const only = (...present) => (p) => present.includes(p);

test("linux: XDG defaults, set, and relative values ignored", () => {
  const home = "/home/u";
  const d = resolvePaths({ env: {}, platform: "linux", home, exists: none });
  assert.equal(d.stateDir, "/home/u/.local/state/see-plan");
  assert.equal(d.dataDir, "/home/u/.local/share/see-plan");
  assert.equal(d.errorLogFile, "/home/u/.local/share/see-plan/error-log.json");
  assert.equal(d.logDir, d.stateDir);
  assert.equal(d.runtimeDir, d.stateDir, "no XDG_RUNTIME_DIR: the state dir");
  assert.equal(d.configDir, "/home/u/.config/see-plan");
  assert.equal(d.runtimeFile, "/home/u/.local/state/see-plan/server.json");
  assert.ok(Object.values(d.source).every((s) => s === "default"));

  const x = resolvePaths({
    env: { XDG_STATE_HOME: "/s", XDG_DATA_HOME: "/d", XDG_CONFIG_HOME: "/c", XDG_RUNTIME_DIR: "/run/user/1000" },
    platform: "linux", home, exists: none,
  });
  assert.equal(x.stateDir, "/s/see-plan");
  assert.equal(x.errorLogFile, "/d/see-plan/error-log.json");
  assert.equal(x.configDir, "/c/see-plan");
  assert.equal(x.runtimeDir, "/run/user/1000/see-plan");

  const rel = resolvePaths({ env: { XDG_STATE_HOME: "relative/state", XDG_DATA_HOME: "./d" }, platform: "linux", home, exists: none });
  assert.equal(rel.stateDir, "/home/u/.local/state/see-plan", "a relative XDG value is ignored");
  assert.equal(rel.dataDir, "/home/u/.local/share/see-plan");
});

test("macOS: ~/Library by default, explicit XDG wins", () => {
  const home = "/Users/u";
  const d = resolvePaths({ env: {}, platform: "darwin", home, exists: none });
  assert.equal(d.stateDir, "/Users/u/Library/Application Support/see-plan");
  assert.equal(d.dataDir, d.stateDir);
  assert.equal(d.logDir, "/Users/u/Library/Logs/see-plan");
  assert.equal(d.runtimeDir, d.stateDir);
  const x = resolvePaths({ env: { XDG_STATE_HOME: "/x/state", XDG_DATA_HOME: "/x/data" }, platform: "darwin", home, exists: none });
  assert.equal(x.stateDir, "/x/state/see-plan");
  assert.equal(x.errorLogFile, "/x/data/see-plan/error-log.json");
});

test("windows: LOCALAPPDATA, and the fallback when it is missing", () => {
  const home = "C:\\Users\\u";
  const d = resolvePaths({ env: { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local", APPDATA: "C:\\Users\\u\\AppData\\Roaming" }, platform: "win32", home, exists: none });
  assert.equal(d.stateDir, "C:\\Users\\u\\AppData\\Local\\see-plan\\state");
  assert.equal(d.errorLogFile, "C:\\Users\\u\\AppData\\Local\\see-plan\\data\\error-log.json");
  assert.equal(d.logFile, "C:\\Users\\u\\AppData\\Local\\see-plan\\logs\\server.log");
  assert.equal(d.runtimeFile, "C:\\Users\\u\\AppData\\Local\\see-plan\\run\\server.json");
  assert.equal(d.configDir, "C:\\Users\\u\\AppData\\Roaming\\see-plan");
  const missing = resolvePaths({ env: {}, platform: "win32", home, exists: none });
  assert.equal(missing.stateDir, "C:\\Users\\u\\AppData\\Local\\see-plan\\state");
  assert.equal(missing.configDir, "C:\\Users\\u\\AppData\\Roaming\\see-plan");
});

test("a legacy folder is used while the new one is missing", () => {
  const home = "/home/u";
  const legacyState = "/home/u/.my-lavish-axi";
  const legacyLog = "/home/u/claude-errors/error-log.json";
  const p = resolvePaths({ env: {}, platform: "linux", home, exists: only(legacyState, legacyLog) });
  assert.equal(p.stateDir, legacyState);
  assert.equal(p.runtimeDir, legacyState, "the runtime file stays with the legacy state");
  assert.equal(p.logFile, "/home/u/.my-lavish-axi/server.log", "server.log stays where it was");
  assert.equal(p.errorLogFile, legacyLog);
  assert.equal(p.source.stateDir, "legacy");
  assert.equal(p.source.errorLogFile, "legacy");
  assert.equal(p.usesLegacy, true);
  assert.equal(p.defaults.stateDir, "/home/u/.local/state/see-plan", "defaults stay the platform paths (the migrate target)");
  // Once the new folder exists, it wins.
  const both = resolvePaths({ env: {}, platform: "linux", home, exists: only(legacyState, "/home/u/.local/state/see-plan") });
  assert.equal(both.stateDir, "/home/u/.local/state/see-plan");
  assert.equal(both.usesLegacy, false);
});

test("env overrides beat legacy and defaults", () => {
  const home = "/home/u";
  const all = () => true;
  const p = resolvePaths({ env: { MY_LAVISH_STATE_DIR: "/iso/state", MY_LAVISH_ERROR_LOG: "/iso/errors.json" }, platform: "linux", home, exists: all });
  assert.equal(p.stateDir, "/iso/state");
  assert.equal(p.runtimeDir, "/iso/state", "an isolated state dir also moves the runtime file (P6)");
  assert.equal(p.logDir, "/iso/state");
  assert.equal(p.errorLogFile, "/iso/errors.json");
  assert.equal(p.source.stateDir, "env");
  assert.equal(p.source.errorLogFile, "env");
  const data = resolvePaths({ env: { MY_LAVISH_DATA_DIR: "/iso/data" }, platform: "linux", home, exists: all });
  assert.equal(data.errorLogFile, "/iso/data/error-log.json");
  assert.equal(data.source.errorLogFile, "env");
});

test("pathRows lists every path with its source; readConfig tolerates junk", () => {
  const p = resolvePaths({ env: {}, platform: "linux", home: "/h", exists: none });
  assert.deepEqual(pathRows(p).map((r) => r.name), ["state", "data", "error_log", "logs", "runtime", "config"]);
  assert.deepEqual(readConfig(p, { readFile: () => "[1]" }), {});
  assert.deepEqual(readConfig(p, { readFile: () => "nope" }), {});
  assert.deepEqual(readConfig(p, { readFile: () => '{"launcher":"copy"}' }), { launcher: "copy" });
});

test("no file under src/ hardcodes a see-plan folder except paths.js", async () => {
  const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
  const offenders = [];
  for (const name of await fs.promises.readdir(src)) {
    if (!name.endsWith(".js") || name === "paths.js") continue;
    const text = await fs.promises.readFile(path.join(src, name), "utf8");
    if (/["'`]\.my-lavish-axi["'`]|["'`]claude-errors["'`]|os\.homedir\(\)[^\n]*error-log/.test(text)) offenders.push(name);
  }
  assert.deepEqual(offenders, []);
});

test("resolvePaths with the real env never throws", () => {
  const p = resolvePaths({ env: { ...process.env, MY_LAVISH_STATE_DIR: os.tmpdir() } });
  assert.equal(p.stateDir, os.tmpdir());
});
