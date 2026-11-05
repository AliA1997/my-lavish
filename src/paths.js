import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** The folder name see-plan uses inside each platform's standard locations. */
export const APP_DIR = "see-plan";
export const ERROR_LOG_NAME = "error-log.json";
export const RUNTIME_FILE = "server.json";
export const LOG_FILE = "server.log";

/**
 * Every path see-plan owns, chosen once (P1-P3). Pure apart from `exists`, which only checks whether the
 * legacy folders and the new ones are there, so an upgrade keeps using old data until `see-plan migrate`.
 *
 * Precedence per path: env override -> legacy (exists, and the new one does not) -> platform default.
 * `source` says which rule chose each path; `defaults` are the platform paths with no env or legacy rule,
 * which is where `see-plan migrate` copies to.
 */
export function resolvePaths({ env = process.env, platform = process.platform, home = homeOf(env, platform), exists = fs.existsSync } = {}) {
  const p = platform === "win32" ? path.win32 : path.posix;
  const abs = (v) => (typeof v === "string" && v !== "" && p.isAbsolute(v) ? v : null);
  const xdg = (name) => abs(env[name]); // a relative XDG value is ignored, as the spec requires
  const join = (...parts) => p.join(...parts);

  let def;
  if (platform === "win32") {
    const local = abs(env.LOCALAPPDATA) ?? join(home, "AppData", "Local");
    const roaming = abs(env.APPDATA) ?? join(home, "AppData", "Roaming");
    const base = join(local, APP_DIR);
    def = { stateDir: join(base, "state"), dataDir: join(base, "data"), logDir: join(base, "logs"), runtimeDir: join(base, "run"), configDir: join(roaming, APP_DIR) };
  } else if (platform === "darwin") {
    // Explicit XDG_* variables win over ~/Library (common with dotfile setups).
    const support = join(home, "Library", "Application Support", APP_DIR);
    const stateDir = xdg("XDG_STATE_HOME") ? join(xdg("XDG_STATE_HOME"), APP_DIR) : support;
    def = {
      stateDir,
      dataDir: xdg("XDG_DATA_HOME") ? join(xdg("XDG_DATA_HOME"), APP_DIR) : support,
      logDir: xdg("XDG_STATE_HOME") ? stateDir : join(home, "Library", "Logs", APP_DIR),
      runtimeDir: xdg("XDG_RUNTIME_DIR") ? join(xdg("XDG_RUNTIME_DIR"), APP_DIR) : stateDir,
      configDir: xdg("XDG_CONFIG_HOME") ? join(xdg("XDG_CONFIG_HOME"), APP_DIR) : support,
    };
  } else {
    const stateDir = join(xdg("XDG_STATE_HOME") ?? join(home, ".local", "state"), APP_DIR);
    def = {
      stateDir,
      dataDir: join(xdg("XDG_DATA_HOME") ?? join(home, ".local", "share"), APP_DIR),
      logDir: stateDir,
      runtimeDir: xdg("XDG_RUNTIME_DIR") ? join(xdg("XDG_RUNTIME_DIR"), APP_DIR) : stateDir,
      configDir: join(xdg("XDG_CONFIG_HOME") ?? join(home, ".config"), APP_DIR),
    };
  }
  def.errorLogFile = join(def.dataDir, ERROR_LOG_NAME);

  const legacy = {
    stateDir: join(home, ".my-lavish-axi"),
    errorLogFile: join(home, "claude-errors", ERROR_LOG_NAME),
  };

  const out = { ...def, legacy, defaults: { ...def }, source: {} };
  for (const k of ["stateDir", "dataDir", "logDir", "runtimeDir", "configDir", "errorLogFile"]) out.source[k] = "default";

  // State: MY_LAVISH_STATE_DIR also moves the runtime file and the log (P6: an isolated server never
  // reads another one's token). A legacy state folder does the same, so an old install stays whole.
  const stateEnv = abs(env.MY_LAVISH_STATE_DIR) ?? (env.MY_LAVISH_STATE_DIR ? p.resolve(env.MY_LAVISH_STATE_DIR) : null);
  if (stateEnv) {
    Object.assign(out, { stateDir: stateEnv, runtimeDir: stateEnv, logDir: stateEnv });
    Object.assign(out.source, { stateDir: "env", runtimeDir: "env", logDir: "env" });
  } else if (exists(legacy.stateDir) && !exists(def.stateDir)) {
    Object.assign(out, { stateDir: legacy.stateDir, runtimeDir: legacy.stateDir, logDir: legacy.stateDir });
    Object.assign(out.source, { stateDir: "legacy", runtimeDir: "legacy", logDir: "legacy" });
  }

  const dataEnv = env.MY_LAVISH_DATA_DIR ? p.resolve(env.MY_LAVISH_DATA_DIR) : null;
  if (dataEnv) {
    out.dataDir = dataEnv;
    out.source.dataDir = "env";
    out.errorLogFile = join(dataEnv, ERROR_LOG_NAME);
    out.source.errorLogFile = "env";
  }
  if (env.MY_LAVISH_ERROR_LOG) {
    out.errorLogFile = p.resolve(env.MY_LAVISH_ERROR_LOG);
    out.source.errorLogFile = "env";
  } else if (!dataEnv && exists(legacy.errorLogFile) && !exists(def.errorLogFile)) {
    out.errorLogFile = legacy.errorLogFile;
    out.source.errorLogFile = "legacy";
  }
  out.runtimeFile = join(out.runtimeDir, RUNTIME_FILE);
  out.logFile = join(out.logDir, LOG_FILE);
  out.usesLegacy = Object.values(out.source).includes("legacy");
  return out;
}

/** The home folder of the env passed in (as os.homedir() reads it), so an injected env is authoritative. */
export function homeOf(env = process.env, platform = process.platform) {
  const v = platform === "win32" ? env.USERPROFILE : env.HOME;
  return typeof v === "string" && v !== "" ? v : os.homedir();
}

/** The optional `config.json` in the config dir: {} when missing or not a JSON object. */
export function readConfig(paths, { readFile = fs.readFileSync } = {}) {
  try {
    const data = JSON.parse(readFile(path.join(paths.configDir, "config.json"), "utf8"));
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

/** `see-plan paths` rows: every path with the rule that chose it. */
export function pathRows(paths) {
  const rows = [
    ["state", paths.stateDir, paths.source.stateDir],
    ["data", paths.dataDir, paths.source.dataDir],
    ["error_log", paths.errorLogFile, paths.source.errorLogFile],
    ["logs", paths.logFile, paths.source.logDir],
    ["runtime", paths.runtimeFile, paths.source.runtimeDir],
    ["config", paths.configDir, paths.source.configDir],
  ];
  return rows.map(([name, p, source]) => ({ name, path: p, source }));
}
