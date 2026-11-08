/**
 * The server's log (S4). In a terminal a person watches (the server window, tmux, `see-plan server` by hand)
 * lines are short and timestamped; otherwise (hidden mode, writing to server.log) they carry an ISO time.
 * Every line is mirrored to server.log when a mirror is given.
 *
 * Never shown: the token, cookies, login nonces, sign-in links, note or transcript text. Callers only pass
 * titles and counts; `secrets` are redacted on top of that as a second line of defence.
 */
export function createConsoleLog({ tty = false, write = (s) => process.stderr.write(s), mirror = null, secrets = [], now = () => new Date() } = {}) {
  const hidden = secrets.filter((s) => typeof s === "string" && s.length >= 8);
  const scrub = (text) => {
    let out = String(text);
    for (const s of hidden) out = out.split(s).join("[redacted]");
    // Sign-in links and cookies never belong in a log, whatever produced them.
    return out.replace(/\/auth\?t=[^\s&"']+/g, "/auth?t=[redacted]").replace(/see_plan_\d+=[^\s;"']+/g, "see_plan_<port>=[redacted]");
  };
  const stamp = () => {
    const d = now();
    return tty ? d.toTimeString().slice(0, 8) : d.toISOString();
  };
  const emit = (line) => {
    const text = `${scrub(line)}\n`;
    write(text);
    mirror?.write(tty ? text.replace(/^\d\d:\d\d:\d\d /, `${now().toISOString()} `) : text);
  };
  return {
    log(message) {
      emit(`${stamp()} ${message}`);
    },
    /** The startup banner: version, URL, paths, how it was started, and how to stop it. No sign-in link (Q8). */
    banner({ version, url, mode, rows = [] }) {
      const how = { window: "in this window", tmux: "in this tmux window", hidden: "hidden (output goes to server.log)", foreground: "in this terminal" }[mode] ?? mode;
      const lines = [
        `see-plan server ${version}`,
        `  ${url}`,
        `  started ${how}`,
        ...rows.map((r) => `  ${r.name.padEnd(9)} ${r.path}${r.source !== "default" ? ` (${r.source})` : ""}`),
        "  To open a page in a browser, run `see-plan url` in a terminal.",
        "  Close this window, press Ctrl+C, or run `see-plan stop` to stop the server.",
      ];
      for (const l of lines) emit(tty ? l : `${now().toISOString()} ${l}`);
    },
  };
}

/** The idle countdown (S4): one line 5 minutes and 1 minute before an idle exit. Returns a cancel function. */
export function scheduleIdleWarnings(totalMs, log, { setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout } = {}) {
  const timers = [];
  for (const [left, text] of [[300000, "5 minutes"], [60000, "1 minute"]]) {
    if (!(totalMs > left)) continue;
    const t = setTimeoutFn(() => log(`idle: the server stops in ${text} unless a page or poll connects`), totalMs - left);
    t?.unref?.();
    timers.push(t);
  }
  return () => {
    for (const t of timers) clearTimeoutFn(t);
  };
}
