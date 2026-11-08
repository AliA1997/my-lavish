import { test } from "node:test";
import assert from "node:assert/strict";
import { detectEnvironment } from "../src/environment.js";
import { KEEP_OPEN_SH, allowedEnv, buildServerLaunch, chooseServerMode, startServerProcess } from "../src/server-launcher.js";
import { createConsoleLog, scheduleIdleWarnings } from "../src/console-log.js";

const none = () => false;
const envOf = (env, platform) => detectEnvironment({ env, platform, exists: none });
const HOSTILE = "/opt/my app/it's $(calc) `id`/node";

test("server mode per fixture: desktop -> window, tmux -> tmux, SSH/CI/container -> hidden", () => {
  assert.equal(chooseServerMode(envOf({}, "win32")).mode, "window");
  assert.equal(chooseServerMode(envOf({ DISPLAY: ":0" }, "linux")).mode, "window");
  assert.equal(chooseServerMode(envOf({}, "darwin")).mode, "window");
  assert.equal(chooseServerMode(envOf({ TMUX: "/tmp/t,1,0", SSH_TTY: "x" }, "linux")).mode, "tmux");
  assert.equal(chooseServerMode(envOf({ SSH_CONNECTION: "x" }, "linux")).mode, "hidden");
  assert.equal(chooseServerMode(envOf({ CI: "true" }, "win32")).mode, "hidden");
  assert.equal(chooseServerMode(detectEnvironment({ env: { DISPLAY: ":0" }, platform: "linux", exists: (p) => p === "/.dockerenv" })).mode, "hidden");
  assert.equal(chooseServerMode(envOf({}, "win32"), "hidden").mode, "hidden", "MY_LAVISH_SERVER_WINDOW=hidden");
  assert.equal(chooseServerMode(envOf({}, "win32"), "bogus").mode, "window", "an unknown value means auto");
});

test("the env wrapper passes exactly the S3 allowlist", () => {
  const env = {
    MY_LAVISH_PORT: "1", MY_LAVISH_STATE_DIR: "/s", XDG_STATE_HOME: "/x", CLAUDE_CONFIG_DIR: "/c", HOME: "/h", PATH: "/bin",
    LOCALAPPDATA: "L", APPDATA: "A", SEE_PLAN_SERVER_MODE: "window",
    AWS_SECRET_ACCESS_KEY: "nope", GITHUB_TOKEN: "nope", SSH_AUTH_SOCK: "nope", TERM: "xterm",
  };
  assert.deepEqual(Object.keys(allowedEnv(env)).sort(), ["APPDATA", "CLAUDE_CONFIG_DIR", "HOME", "LOCALAPPDATA", "MY_LAVISH_PORT", "MY_LAVISH_STATE_DIR", "PATH", "SEE_PLAN_SERVER_MODE", "XDG_STATE_HOME"]);
  const linux = buildServerLaunch({ mode: "window", platform: "linux", exe: "/usr/bin/node", args: ["/b/see-plan.js", "server"], env, port: 4388, terminal: "/usr/bin/xterm" });
  const vars = linux.args.slice(2).filter((a) => /^[A-Z_]+=/.test(a)).map((a) => a.split("=")[0]);
  assert.deepEqual(vars.sort(), ["APPDATA", "CLAUDE_CONFIG_DIR", "HOME", "LOCALAPPDATA", "MY_LAVISH_PORT", "MY_LAVISH_STATE_DIR", "PATH", "SEE_PLAN_SERVER_MODE", "SEE_PLAN_TITLE", "XDG_STATE_HOME"]);
});

test("no shell strings: a path with spaces, quotes and $() stays one argv item on all three OSes", () => {
  const args = ["/b/it's here/see-plan.js", "server"];
  const linux = buildServerLaunch({ mode: "window", platform: "linux", exe: HOSTILE, args, env: {}, port: 1, terminal: "/usr/bin/gnome-terminal" });
  assert.equal(linux.command, "/usr/bin/gnome-terminal");
  assert.equal(linux.args[0], "--");
  assert.ok(linux.args.includes(HOSTILE) && linux.args.includes(args[0]));
  assert.ok(linux.args.includes(KEEP_OPEN_SH), "the shell script is fixed text");
  assert.ok(!KEEP_OPEN_SH.includes("calc"));

  const mac = buildServerLaunch({ mode: "window", platform: "darwin", exe: HOSTILE, args, env: {}, port: 1 });
  assert.equal(mac.command, "/usr/bin/osascript");
  const script = mac.args.filter((a, i) => i % 2 === 1).join("\n");
  assert.ok(!script.includes("calc") && !script.includes("it's"), "nothing spliced into AppleScript");
  assert.ok(Object.values(mac.env).includes(HOSTILE));
  assert.equal(Number(mac.env.SEE_PLAN_ARGC), Object.keys(mac.env).filter((k) => k.startsWith("SEE_PLAN_ARG_")).length);

  const win = buildServerLaunch({ mode: "window", platform: "win32", exe: "C:\\Program Files\\it's $(calc)\\node.exe", args, env: { A: "1" }, port: 1 });
  assert.match(win.command, /powershell\.exe$/i);
  const ps = Buffer.from(win.args.at(-1), "base64").toString("utf16le");
  assert.ok(!ps.includes("calc") && ps.includes("$env:SEE_PLAN_SERVER_EXE") && ps.includes("Read-Host"));
  assert.deepEqual(JSON.parse(win.env.SEE_PLAN_SERVER_ARGS), args);
  assert.equal(win.options.detached, true, "detached gives the server its own console window");
  assert.equal(win.env.SEE_PLAN_TITLE, "see-plan server · :1");

  const tmux = buildServerLaunch({ mode: "tmux", platform: "linux", exe: HOSTILE, args, env: {}, port: 1, environment: { tmux: true, tmux_socket: "/tmp/t" } });
  assert.deepEqual(tmux.args.slice(0, 6), ["-S", "/tmp/t", "new-window", "-d", "-n", "see-plan-server"]);
});

function fakeSpawn(calls, { fail = false } = {}) {
  return (command, args, opts) => {
    calls.push({ command, args, opts });
    const h = {};
    setImmediate(() => (fail ? h.error?.(Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" })) : h.spawn?.()));
    return { once: (ev, fn) => { h[ev] = fn; }, on() {}, unref() {} };
  };
}

function ctx({ upAfterWindow = true } = {}) {
  const log = { hidden: 0, waits: [] };
  return {
    log,
    ctx: {
      env: { PATH: "/bin" }, port: 4388, paths: {},
      waitUp: async (ms) => {
        log.waits.push(ms);
        if (ms === 15000 && !upAfterWindow) return { reason: "/health did not answer" };
        return { conn: { baseUrl: "http://127.0.0.1:4388", token: "t", pid: 7 } };
      },
    },
    startHidden: async () => {
      log.hidden++;
    },
  };
}

test("startServerProcess: a window waits 15 s; spawn errors and a silent window fall back to hidden once", async () => {
  const calls = [];
  const a = ctx();
  const win = await startServerProcess(a.ctx, { environment: envOf({}, "win32"), platform: "win32", exe: "node", args: ["s"], spawnFn: fakeSpawn(calls), startHidden: a.startHidden });
  assert.deepEqual([win.mode, a.log.hidden, a.log.waits], ["window", 0, [15000]]);
  assert.equal(calls.length, 1);

  const b = ctx();
  const failed = await startServerProcess(b.ctx, { environment: envOf({}, "win32"), platform: "win32", exe: "node", args: ["s"], spawnFn: fakeSpawn([], { fail: true }), startHidden: b.startHidden });
  assert.equal(failed.mode, "hidden");
  assert.equal(b.log.hidden, 1, "hidden exactly once");
  assert.deepEqual(failed.fallback.requested, "window");
  assert.match(failed.fallback.reason, /not installed|ENOENT/);

  const c = ctx({ upAfterWindow: false });
  const silent = await startServerProcess(c.ctx, { environment: envOf({}, "win32"), platform: "win32", exe: "node", args: ["s"], spawnFn: fakeSpawn([]), startHidden: c.startHidden });
  assert.deepEqual([silent.mode, c.log.hidden, c.log.waits], ["hidden", 1, [15000, 5000]]);
  assert.match(silent.fallback.reason, /did not answer within 15s/);

  const d = ctx();
  const noTerm = await startServerProcess(d.ctx, { environment: envOf({ DISPLAY: ":0" }, "linux"), platform: "linux", exe: "node", args: ["s"], spawnFn: fakeSpawn([]), startHidden: d.startHidden, which: async () => null });
  assert.equal(noTerm.mode, "hidden");
  assert.match(noTerm.fallback.reason, /no terminal/);

  const e = ctx();
  const headless = await startServerProcess(e.ctx, { environment: envOf({ CI: "1" }, "linux"), platform: "linux", exe: "node", args: ["s"], spawnFn: fakeSpawn([]), startHidden: e.startHidden });
  assert.deepEqual([headless.mode, headless.fallback, e.log.waits], ["hidden", undefined, [5000]], "CI: hidden from the start, 5 s");
});

test("console log: timestamps, banner without a sign-in link, and secrets redacted", () => {
  const out = [];
  const mirror = [];
  const token = "tok_" + "A".repeat(40);
  const log = createConsoleLog({ tty: true, write: (s) => out.push(s), mirror: { write: (s) => mirror.push(s) }, secrets: [token], now: () => new Date("2026-11-04T10:20:30Z") });
  log.log(`leak ${token} and http://127.0.0.1:1/auth?t=abcdef123456&next=%2F and see_plan_4388=deadbeef`);
  log.banner({ version: "4.0.0", url: "http://127.0.0.1:4388/", mode: "window", rows: [{ name: "state", path: "/s", source: "default" }] });
  const text = out.join("");
  assert.ok(!text.includes(token) && !text.includes("abcdef123456") && !text.includes("deadbeef"));
  assert.match(text, /see-plan server 4\.0\.0/);
  assert.match(text, /run `see-plan url`/);
  assert.match(text, /Close this window, press Ctrl\+C, or run `see-plan stop`/);
  assert.ok(!/\/auth\?/.test(text.replace("/auth?t=[redacted]", "")), "no sign-in link");
  assert.ok(mirror.join("").includes("2026-11-04T"), "the server.log mirror carries ISO times");
});

test("idle countdown lines at 5 minutes and 1 minute, with a fake clock", () => {
  const timers = [];
  const lines = [];
  const cancel = scheduleIdleWarnings(1800000, (l) => lines.push(l), { setTimeoutFn: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeoutFn: () => {} });
  assert.deepEqual(timers.map((t) => t.ms), [1500000, 1740000]);
  for (const t of timers) t.fn();
  assert.deepEqual(lines, ["idle: the server stops in 5 minutes unless a page or poll connects", "idle: the server stops in 1 minute unless a page or poll connects"]);
  cancel();
  assert.equal(scheduleIdleWarnings(30000, () => {}, { setTimeoutFn: () => assert.fail("no warning for a short idle timeout") }) instanceof Function, true);
});
