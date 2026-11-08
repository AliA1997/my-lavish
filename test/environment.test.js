import { test } from "node:test";
import assert from "node:assert/strict";
import { canOpenBrowser, detectEnvironment, envHeader, parseEnvHeader } from "../src/environment.js";
import { buildTmuxLaunch, chooseStrategy, claudeStatus, expandTerminal, launchClaude, launcherSettings, parseTerminalArgv } from "../src/claude-launcher.js";

const none = () => false;
const FIXTURES = {
  "plain Linux desktop": { platform: "linux", env: { DISPLAY: ":0" }, gui: true, remote: false },
  "Wayland desktop": { platform: "linux", env: { WAYLAND_DISPLAY: "wayland-0" }, gui: true },
  "SSH into Linux": { platform: "linux", env: { SSH_CONNECTION: "1.2.3.4 5 6.7.8.9 22" }, gui: false, remote: true },
  "SSH with X forwarding": { platform: "linux", env: { SSH_CONNECTION: "x", DISPLAY: "localhost:10.0" }, gui: true, remote: true },
  "Codespaces": { platform: "linux", env: { CODESPACES: "true" }, gui: false, remote: true },
  "Docker": { platform: "linux", env: {}, exists: (p) => p === "/.dockerenv", gui: false, container: true },
  "Podman": { platform: "linux", env: {}, exists: (p) => p === "/run/.containerenv", gui: false, container: true },
  "WSL without WSLg": { platform: "linux", env: { WSL_DISTRO_NAME: "Ubuntu" }, gui: false, wsl: true },
  "tmux over SSH": { platform: "linux", env: { TMUX: "/tmp/tmux-1000/default,123,0", SSH_TTY: "/dev/pts/1" }, gui: false, tmux: true },
  "macOS over SSH": { platform: "darwin", env: { SSH_TTY: "/dev/ttys001" }, gui: false, remote: true },
  "macOS desktop": { platform: "darwin", env: {}, gui: true },
  "Windows desktop": { platform: "win32", env: {}, gui: true },
  "CI on Windows": { platform: "win32", env: { CI: "true" }, gui: false, ci: true },
};

test("detectEnvironment: a table of places see-plan runs", () => {
  for (const [name, f] of Object.entries(FIXTURES)) {
    const e = detectEnvironment({ env: f.env, platform: f.platform, exists: f.exists ?? none });
    for (const k of ["gui", "remote", "container", "wsl", "tmux", "ci"]) {
      if (k in f) assert.equal(e[k], f[k], `${name}: ${k}`);
    }
    if (!e.gui) assert.ok(e.reasons.length > 0, `${name}: a false gui comes with a reason`);
  }
  assert.equal(detectEnvironment({ env: { TMUX: "/tmp/tmux-1000/default,1,0" }, platform: "linux", exists: none }).tmux_socket, "/tmp/tmux-1000/default");
  assert.equal(canOpenBrowser(detectEnvironment({ env: { WSL_DISTRO_NAME: "Ubuntu" }, platform: "linux", exists: none })), true, "WSL opens the Windows browser");
  assert.equal(canOpenBrowser(detectEnvironment({ env: { CODESPACES: "true" }, platform: "linux", exists: none })), false);
});

test("the X-See-Plan-Env header round-trips and is validated", () => {
  const e = detectEnvironment({ env: FIXTURES["tmux over SSH"].env, platform: "linux", exists: none });
  const parsed = parseEnvHeader(envHeader(e));
  assert.equal(parsed.tmux, true);
  assert.equal(parsed.remote, true);
  assert.equal(parsed.tmux_socket, "/tmp/tmux-1000/default");
  assert.ok(envHeader({ ...e, reasons: Array(50).fill("x".repeat(300)) }).length <= 2048, "size-capped");
  for (const bad of ["", "nope", "[]", JSON.stringify({ gui: "yes" }), JSON.stringify({ ...parsed, platform: "plan9" }), JSON.stringify({ ...parsed, tmux_socket: "relative" }), "x".repeat(3000)]) {
    assert.equal(parseEnvHeader(bad), null, bad.slice(0, 30));
  }
});

test("chooseStrategy per fixture: terminal on a desktop, tmux inside tmux, else copy; MY_LAVISH_LAUNCHER forces", () => {
  const strategy = (name, settings) => chooseStrategy(detectEnvironment({ env: FIXTURES[name].env, platform: FIXTURES[name].platform, exists: FIXTURES[name].exists ?? none }), settings).strategy;
  assert.equal(strategy("plain Linux desktop"), "terminal");
  assert.equal(strategy("Windows desktop"), "terminal");
  assert.equal(strategy("tmux over SSH"), "tmux");
  assert.equal(strategy("SSH into Linux"), "copy");
  assert.equal(strategy("Codespaces"), "copy");
  assert.equal(strategy("Docker"), "copy");
  assert.equal(strategy("macOS over SSH"), "copy");
  assert.equal(strategy("Windows desktop", { launcher: "copy" }), "copy");
  assert.equal(strategy("SSH into Linux", { launcher: "tmux" }), "tmux");
  assert.equal(strategy("Windows desktop", { launcher: "off" }), "off");
  assert.deepEqual(launcherSettings({ MY_LAVISH_LAUNCHER: "bogus" }).launcher, "auto");
  assert.equal(launcherSettings({}, { launcher: "copy" }).launcher, "copy", "config.json `launcher`");
});

test("tmux argv: no shell string; a prompt with quotes and $() stays one argv item", () => {
  const prompt = `say "hi"; $(rm -rf ~) 'x' \`id\``;
  const t = buildTmuxLaunch({ argv: ["/usr/bin/claude", "--session-id", "id", prompt], name: "auth;rm", cwd: "/r w", socket: "/tmp/tmux-1/default" });
  assert.equal(t.command, "tmux");
  assert.deepEqual(t.args.slice(0, 9), ["-S", "/tmp/tmux-1/default", "new-window", "-d", "-n", "see-plan-auth-rm", "-c", "/r w", "--"]);
  assert.equal(t.args.at(-1), prompt);
  const detached = buildTmuxLaunch({ argv: ["c"], name: "x", cwd: "/", inTmux: false });
  assert.deepEqual(detached.args.slice(0, 4), ["new-session", "-d", "-s", "see-plan"]);
});

test("MY_LAVISH_TERMINAL: a JSON argv array with exactly one {cmd...}; anything else is refused", () => {
  assert.deepEqual(parseTerminalArgv('["wezterm","start","--","{cmd...}"]'), ["wezterm", "start", "--", "{cmd...}"]);
  assert.deepEqual(expandTerminal(["wezterm", "start", "--", "{cmd...}"], ["a b", "c"]), ["wezterm", "start", "--", "a b", "c"]);
  assert.equal(parseTerminalArgv(undefined), null);
  for (const bad of ["wezterm start", '["wezterm"]', '["wezterm","start"]', '["a","{cmd...}","{cmd...}"]', '["{cmd...}","x"]', '[1,"{cmd...}"]', '{"a":1}']) {
    assert.throws(() => parseTerminalArgv(bad), { code: "VALIDATION_ERROR" }, bad);
  }
  assert.match(launcherSettings({ MY_LAVISH_TERMINAL: "xterm -e" }).terminalError, /JSON array/);
});

const ID = "1b4e28ba-2fa1-11d2-883f-0016d3cca427";
const fakeSpawn = (calls, { fail = false } = {}) => (command, args, opts) => {
  calls.push({ command, args, opts });
  const handlers = {};
  setImmediate(() => (fail ? handlers.error?.(Object.assign(new Error("ENOENT"), { code: "ENOENT" })) : handlers.spawn?.()));
  return { once: (ev, fn) => { handlers[ev] = fn; }, on() {}, unref() {} };
};

test("launchClaude: headless picks copy, tmux opens a detached window, off refuses, a custom terminal is expanded", async () => {
  const find = async () => "/usr/bin/claude";
  const ssh = detectEnvironment({ env: FIXTURES["SSH into Linux"].env, platform: "linux", exists: none });
  const calls = [];
  const copy = await launchClaude({ file: "/r/p.md", cwd: "/r", sessionId: ID, environment: ssh }, { platform: "linux", spawnFn: fakeSpawn(calls), findClaude: find, which: async () => "/usr/bin/xterm" });
  assert.equal(copy.mode, "copy", "xterm is installed, but there is no DISPLAY: never a silent no-op");
  assert.ok(copy.strategy_reasons.some((r) => /DISPLAY/.test(r)));
  assert.equal(calls.length, 0);

  const tm = detectEnvironment({ env: FIXTURES["tmux over SSH"].env, platform: "linux", exists: none });
  const t = await launchClaude({ file: "/r/auth.plan.md", cwd: "/r", sessionId: ID, environment: tm, feature: "auth" }, { platform: "linux", spawnFn: fakeSpawn(calls), findClaude: find });
  assert.deepEqual([t.mode, t.tmux_window], ["tmux", "see-plan-auth"]);
  assert.equal(calls[0].command, "tmux");
  assert.ok(calls[0].args.includes("-d"), "detached: it never takes focus");

  const noTmux = await launchClaude({ file: "/r/p.md", cwd: "/r", sessionId: ID, environment: tm }, { platform: "linux", spawnFn: fakeSpawn([], { fail: true }), findClaude: find });
  assert.equal(noTmux.mode, "copy", "tmux missing: fall back to copy");

  await assert.rejects(launchClaude({ file: "f", cwd: "/r", sessionId: ID, config: { launcher: "off" } }, { platform: "linux", findClaude: find }), { code: "LAUNCHER_OFF" });
  assert.equal((await claudeStatus({ platform: "linux", findClaude: find, settings: { launcher: "off" } })).launch, "off");

  const desk = detectEnvironment({ env: { DISPLAY: ":0" }, platform: "linux", exists: none });
  const custom = [];
  await launchClaude({ file: "/r/p.md", cwd: "/r", sessionId: ID, environment: desk, config: { terminal: ["wezterm", "start", "--", "{cmd...}"] } }, { platform: "linux", spawnFn: fakeSpawn(custom), findClaude: find });
  assert.equal(custom[0].command, "wezterm");
  assert.deepEqual(custom[0].args.slice(0, 5), ["start", "--", "/usr/bin/claude", "--session-id", ID]);
});
