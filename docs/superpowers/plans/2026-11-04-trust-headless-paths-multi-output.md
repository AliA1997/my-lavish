# see-plan: multiple outputs per review, standard state paths, a local auth token, headless Connect Claude, and a visible server window

Date: 2026-11-04 · Status: **implemented 2026-11-08 (4.0.0, unreleased); see "Implementation notes" at the end** · Version at time of writing: 3.2.0 (`main` @ 734c07f) · Ships as **3.3.0** (Phase 1, paths) then **4.0.0** (Phases 2–4; breaking: API auth, artifact URLs)

## Why this plan exists

A review of the project raised four problems. This plan fixes each one:

| # | Problem raised | What is actually true today (checked 2026-11-04) | Fix in this plan |
| --- | --- | --- | --- |
| A | "Only static HTML layouts, no rich interactive UI" (because lavish-axi's Mermaid/Excalidraw/layout audit were left out). | Half true. Artifacts are served with `sandbox allow-scripts allow-forms allow-popups` (`src/server.js` ~L1741), so JS prototypes **do run**. But `public/sdk.js` L357–363 grabs every click and calls `preventDefault()`, so you can't actually use an interactive page and annotate it at the same time. A session also holds **one file**, and only `.html` and `.md` are accepted. | Phase 4: **multiple outputs** per review session, more output kinds, and an Interact/Annotate toggle. |
| B | State and logs go to hardcoded `~/.my-lavish-axi` and `~/claude-errors/error-log.json` instead of XDG / `%LOCALAPPDATA%`. | True. `src/cli.js:39`, `src/cli.js:87`, `src/server.js:135`, `src/logs-page.js:33`, `skills/my-lavish/SKILL.md:19` and the README all hardcode them. | Phase 1: a single `src/paths.js` that follows each platform's standard, keeps the legacy folders working, and adds `see-plan paths` / `see-plan migrate`. |
| C | No token, so any local process can forge requests. | True for header-less requests. The server already blocks **browser** attacks: a Host allowlist stops DNS rebinding (`src/server.js:385`), and an Origin guard plus `requireSameOrigin` refuse cross-site writes. But a request with no Origin header (any `curl`) passes, so it can launch Claude, write error records and consume feedback. `/health` also leaks `state_dir`. | Phase 2: a per-server secret token, given to the CLI through a user-only file and to the browser through a one-time link that sets a cookie. Artifact frames get capability URLs. |
| D | Connect Claude needs a GUI terminal, so it breaks in Docker, Codespaces and SSH. | True. `claude-launcher.js` tries PowerShell, Terminal.app, then 4 Linux terminals, and only falls back to `copy` when **no binary is found**. Over SSH with `xterm` installed but no `$DISPLAY`, the spawn "succeeds" and nothing opens. `openUrl` runs `xdg-open` blindly. | Phase 3: environment detection, ordered launch strategies (`terminal` → `tmux` → `copy`), user-set launcher/terminal, and printing URLs instead of opening a browser when headless. |
| E | *New request:* when see-plan starts, it should open a new window with the server running in it. | Today `ensureServer` (`src/cli.js:245`) starts the server **hidden** (`detached`, `windowsHide: true`, output only to `server.log`). You can't see that it's running or what it's doing, and the only way to stop it is `see-plan stop`. The server has no SIGINT/SIGTERM handler, and a poll whose server dies mid-wait fails instead of reconnecting. | Phase 3, part 2 (S1–S9): start the server in its own visible terminal window, using the same strategy chain as Connect Claude, with a readable live log, a clean shutdown when the window is closed, and the hidden start as the fallback. |

### What "takes multiple output" means here

I read it as: **one review can take several outputs from the agent** (for example a plan `.md`, an architecture `.mmd` diagram, a clickable `.html` prototype and a screenshot), **of several kinds**, and the human's notes come back tagged with the output they belong to. That is the direct answer to problem A. This reading was confirmed in Q1.

## Goal

1. `see-plan open plan.md flow.mmd proto.html shot.png` opens **one** review with a tab for each output. `poll` returns each note with `output: {id, file, kind}`.
2. Kinds: `html` (interactive, with an Interact/Annotate toggle), `markdown` (existing), `mermaid`, `image` (`.png/.jpg/.gif/.webp/.svg`), `text` (`.txt/.log/.json/.csv`, shown as text or a table). All are rendered **locally**: no CDN, no cloud.
3. State, logs, the runtime file and the error log live in the platform's standard folders. Existing installs keep working with no data loss, and `see-plan paths` shows where everything is.
4. Every API call, page and WebSocket needs the server's token, by bearer header (CLI) or cookie (browser). `/health` returns only `{ok, app, version, auth}`.
5. Connect Claude and browser opening work, or fail **clearly with a command to copy**, in Docker, Codespaces, SSH, WSL and tmux.
6. When a see-plan command has to start the server, the server opens in **its own new terminal window** (titled `see-plan server · :<port>`) that shows a live, readable log. Closing that window (or pressing Ctrl+C in it) stops the server cleanly. With no desktop, it runs in a tmux window or hidden in the background, as today.

## Non-goals

- Tailscale or any remote access, Excalidraw editing, the layout-issue audit (still left out on purpose; see README "Differences").
- Protecting against **malware that already runs as the same OS user**. It can read the token file, `~/.claude` and everything else that user owns. The token stops other OS users, sandboxed or containerised processes that share the network but not the user's files, and browser-based attacks. The README must say this plainly.
- Filtering error logs by project (unchanged from D14 of the 2026-11-04 error-tabs plan).

## Design decisions

### Phase 1: paths (problem B)

- **P1. One module owns every path.** `src/paths.js` exports `resolvePaths({env, platform, home})` → `{stateDir, dataDir, runtimeDir, logDir, configDir, errorLogFile, legacy: {...}, source: {...}}`. Nothing else calls `os.homedir()` for see-plan's own files. `~/.claude` (Claude's dir) stays where it is, because Claude owns it.
- **P2. Defaults per platform** (app folder name `see-plan`):

| | Linux / other POSIX | macOS | Windows |
| --- | --- | --- | --- |
| state (`state.json`, `revisions/`, `feedback.jsonl`) | `$XDG_STATE_HOME/see-plan` (`~/.local/state/see-plan`) | `~/Library/Application Support/see-plan` | `%LOCALAPPDATA%\see-plan\state` |
| data (`error-log.json`) | `$XDG_DATA_HOME/see-plan` (`~/.local/share/see-plan`) | `~/Library/Application Support/see-plan` | `%LOCALAPPDATA%\see-plan\data` |
| logs (`server.log`) | state dir | `~/Library/Logs/see-plan` | `%LOCALAPPDATA%\see-plan\logs` |
| runtime (`server.json`: port, pid, token) | `$XDG_RUNTIME_DIR/see-plan`, else the state dir | state dir | `%LOCALAPPDATA%\see-plan\run` |
| config (`config.json`, optional) | `$XDG_CONFIG_HOME/see-plan` | `~/Library/Application Support/see-plan` | `%APPDATA%\see-plan` |

  On macOS, explicitly set `XDG_*` variables win over `~/Library` (common for dotfile users). A relative `XDG_*` value is ignored, as the spec requires.
- **P3. Precedence, highest first:** env override (`MY_LAVISH_STATE_DIR`, `MY_LAVISH_ERROR_LOG`, new `MY_LAVISH_DATA_DIR`) → **legacy folder, if it exists and the new one doesn't** → platform default. An upgrade therefore never "loses" sessions or error records. `resolvePaths` reports which rule chose each path (`source.stateDir = "legacy"`).
- **P4. Migration is explicit.** `see-plan migrate [--dry-run]` stops the server, copies `~/.my-lavish-axi` and `~/claude-errors/error-log.json` into the new folders, checks them (JSON parses, record counts match), then renames the old ones to `*.migrated-<date>`. It never deletes them. It refuses if the new location already has data. Bare `see-plan` adds one line, `legacy_paths: run see-plan migrate`, while legacy paths are in use.
- **P5. Agents find the error log through the CLI**, not a hardcoded path. `see-plan paths [--json]` prints every path and its source. SKILL.md, `errorLogStep` (`src/cli.js:86`), the `/claude` tip (`src/logs-page.js:33`) and the README take the path from `resolvePaths`.
- **P6. Multi-project setups:** keep one shared server (the design depends on it). Isolation stays opt-in through `MY_LAVISH_STATE_DIR` + `MY_LAVISH_PORT`, which now also moves the runtime file, so two isolated servers never read each other's token. Documented with an example.

### Phase 2: local trust (problem C)

- **T1. Threat model** (written into the README): the token stops (a) other OS users on a shared machine, (b) processes that can reach `127.0.0.1` but can't read the user's home (containers sharing the host network, sandboxed tools, browser extensions without file access), and (c) browser attacks (already blocked; kept). It does **not** stop same-user malware (see Non-goals).
- **T2. Token.** At startup the server makes 32 random bytes (`crypto.randomBytes`, base64url). It writes `server.json {port, pid, token, version, started_at}` to the runtime dir **atomically** (temp file + rename), mode `0600` in a `0700` folder on POSIX. On Windows, the file also gets a user-only ACL through `icacls` (Q3). If that fails, the server logs a warning and keeps going. A new token is made on every server start; it is never stored in `state.json` and never logged.
- **T3. The CLI** reads `server.json` and sends `Authorization: Bearer <token>` on every request (`ensureServer`, poll, reply, etc.). If the file is missing, unreadable or stale (the pid is gone or the port doesn't match), the CLI treats the server as down and restarts it, or reports `SERVER_TOKEN_UNREADABLE` with a `next_step`.
- **T4. The browser** gets in through a one-time **login link**: the CLI opens `http://127.0.0.1:<port>/auth?t=<nonce>&next=/session/<key>`, where `nonce` is a single-use, 60 s value the CLI gets from `POST /api/auth/nonce` (bearer). The server answers `/auth` by setting the cookie `see_plan_<port>=<token-derived session id>; HttpOnly; SameSite=Strict; Path=/` and redirecting with `303` to `next` (a same-origin relative path only), so the token never stays in the address bar or history. Pages opened without the cookie show a static 401 page: "Run `see-plan url` in a terminal to get a sign-in link." New command: **`see-plan url [file|logs|errors]`** prints a fresh login link (for headless use and bookmarks).
- **T5. Where the token is checked:** Express middleware placed right after the Host allowlist. Bearer **or** cookie; compared with `crypto.timingSafeEqual`. Exempt: `GET /health` (now only `{ok, app, version, auth: "token"}`, no `state_dir`), `GET /auth`, the 401 page and the static `PUBLIC_ASSETS`. The WebSocket upgrade (`onUpgrade`) checks the cookie too. The existing Origin and `requireSameOrigin` checks stay as defence in depth.
- **T6. Artifact frames use capability URLs.** A sandboxed iframe without `allow-same-origin` has an opaque origin, so its sub-requests (images, CSS) may not carry a `SameSite=Strict` cookie. Instead, artifacts are served from `/artifact/<key>/<cap>/…`, where `cap = HMAC-SHA256(token, key)` truncated to 32 hex digits. The parent page (already authenticated) puts the capability in the iframe `src`; relative asset paths keep working because they resolve under the same prefix. The old `/artifact/<key>/…` routes return 404. Task 2.4 checks this in a real browser.
- **T7. Old CLI against a new server:** a 3.x CLI gets `401` with body `{error: {code: "AUTH_REQUIRED", message: "…upgrade see-plan…"}}`. `/health.version` lets a 4.x CLI tell the user to run `see-plan stop` when an older server without auth is running.
- **T8. No off switch, not even for tests** (Q4). Tests and smoke runs read the token from the runtime dir like any CLI.

### Phase 3: headless Connect Claude (problem D)

- **H1. `src/environment.js` → `detectEnvironment({env, platform, fs})`** returns `{gui, remote, container, wsl, tmux, ci, reasons[]}`:
  - `gui`: Windows/macOS → true unless `SSH_CONNECTION`/`SSH_TTY` is set. Linux → `DISPLAY` or `WAYLAND_DISPLAY` is set.
  - `remote`: `SSH_CONNECTION`, `SSH_TTY`, `CODESPACES`, `REMOTE_CONTAINERS`, `GITPOD_WORKSPACE_ID`.
  - `container`: `/.dockerenv`, `/run/.containerenv`, or `container` env.
  - `wsl`: `WSL_DISTRO_NAME`; then the browser opens through `wslview` or `explorer.exe` if found.
  - `tmux`: `TMUX`. `ci`: `CI`.
- **H2. The server can't trust its own environment.** It is one long-lived process, maybe started from a GUI terminal and later used over SSH. So each CLI call sends its detected environment (`X-See-Plan-Env: <json>` on open/poll), the server stores the latest per review session, and Connect Claude uses the **newest environment for that session**, falling back to the server's own.
- **H3. Ordered launch strategies**, the first that applies wins:
  1. `terminal` when `gui` is true (today's PowerShell / Terminal.app / Linux list; Linux also honours `$TERMINAL`).
  2. `tmux` when `tmux` is true, or `tmux` is on PATH and the user chose it: `tmux new-window -d -n see-plan-<feature> -c <cwd> -- <claude> --session-id <id> <prompt>`, argv only, no shell string. The card then says "Started in tmux window `see-plan-<feature>`; attach with `tmux select-window -t …`".
  3. `copy` (today's fallback), now **also chosen whenever `gui` is false**, not only when no binary exists.
  - `MY_LAVISH_LAUNCHER=auto|terminal|tmux|copy|off` (or `launcher` in `config.json`) forces one. `off` hides Connect Claude entirely.
  - `MY_LAVISH_TERMINAL` / `config.json` `terminal`: a **JSON argv array** with the placeholder `"{cmd...}"`, e.g. `["wezterm","start","--","{cmd...}"]`. It is expanded as argv, never as a shell string, and validated (array of strings, exactly one placeholder).
- **H4. Browser opening:** when `gui` is false, `openUrl` isn't called. The CLI prints `url:` with a `next_step` that mentions port forwarding (`ssh -L 4388:127.0.0.1:4388 …`; VS Code / Codespaces forward it automatically). `openUrl` failures (spawn error, `xdg-open` missing) become `{opened: false, reason}` instead of throwing.
- **H5. Port-forwarded hosts.** Codespaces' web forwarding sends `Host: <name>-4388.app.github.dev`, which the Host allowlist rejects. New `MY_LAVISH_ALLOWED_HOSTS` (comma list, exact hostnames) adds to the allowlist, and **is only accepted once Phase 2 auth exists**, so a widened Host check is never unauthenticated. The cookie gets `Secure` when the request arrived as `https` through a forwarder (`X-Forwarded-Proto`, trusted only for allowlisted hosts).
- **H6. Stuck hints:** the existing 45 s *stuck* state adds the launch strategy and detection reasons ("Opened with xterm but `DISPLAY` was not set when you ran see-plan").

### Phase 3, part 2: the server opens in its own window (request E)

- **S1. When the window opens.** Only when a CLI command **has to start** the server: `ensureServer` found nothing on `/health`. A running server is reused as today, so there is at most one server window at a time. `see-plan server` (run by hand) stays in the current terminal and never opens another window.
- **S2. Window strategies.** The S2 chain reuses H1 detection and the H3 terminal builders:
  1. `window` when `gui` is true. **Windows:** a new PowerShell console. **macOS:** a new Terminal.app window via `osascript`. **Linux:** `MY_LAVISH_TERMINAL` / `$TERMINAL` / the `LINUX_TERMINALS` list.
  2. `tmux` when the CLI runs inside tmux: `tmux new-window -d -n see-plan-server`. It is created detached, so it doesn't take focus from the agent's window.
  3. `hidden`: today's detached, `windowsHide` start writing to `server.log`. Used when there is no GUI and no tmux, in CI and containers, and as the fallback when the other two fail.

  The setting is `MY_LAVISH_SERVER_WINDOW=auto|window|tmux|hidden` (or `server_window` in `config.json`). **The default `auto` opens a normal window** (decided in Q7). `MY_LAVISH_NO_OPEN=1` / `--no-open` don't change it: they are about the browser.
- **S3. No shell strings, and the environment survives.** The command is the same `process.execPath` + `serverSpawnArgs()` the hidden start uses.
  - **Windows:** the command goes to PowerShell through env vars (`SEE_PLAN_SERVER_EXE`, `SEE_PLAN_SERVER_ARGS` as JSON) inside a constant `-EncodedCommand` script, as the Claude launcher already does.
  - **Terminal.app and some Linux terminals** (gnome-terminal's server process) start a fresh shell that does **not** inherit the CLI's environment, so `MY_LAVISH_*` and `XDG_*` overrides would be lost and the window would run a different server (other port, other state folder). The command is wrapped as `/usr/bin/env K=V … <exe> <args>`. On macOS, AppleScript builds it with `quoted form of (system attribute …)`.
  - **Which variables are passed:** an allowlist of `MY_LAVISH_*`, `XDG_*`, `CLAUDE_CONFIG_DIR`, `HOME`, `PATH`, `LOCALAPPDATA` and `APPDATA`. Nothing else is copied.
- **S4. What the window shows.** The server switches to a "console" log format when stdout is a TTY. Output is also written to `server.log` in the log dir, so `hidden` mode and old instructions keep working.
  - **Startup banner:** version, `http://127.0.0.1:<port>/`, the paths from `see-plan paths`, the strategy used, and "Close this window, press Ctrl+C, or run `see-plan stop` to stop the server."
  - **Then one line per event:** session opened/ended, poll connected/returned, feedback sent, Connect Claude launched, error logged, idle-timeout countdown at 5 min and at 1 min.
  - **Never shown:** the auth token, cookies, login nonces, sign-in links (Q8), note text or transcript text (titles and counts only). To get into the page, the banner says to run `see-plan url`.
- **S5. Clean shutdown.** New SIGINT, SIGTERM, SIGHUP and Windows `SIGBREAK` / console-close handlers in `cmdServer`. On a signal the server:
  1. stops accepting connections;
  2. answers waiting polls with `{status: "waiting", reconnect: true}`;
  3. closes WebSockets with code 1001;
  4. waits for in-flight `store.transact` writes;
  5. deletes `server.json` (only if it still holds its own pid);
  6. exits 0.

  The same path serves `POST /shutdown` and the idle timeout. On Windows, closing the console window gives the process about 5 s, so the steps above have a 3 s hard limit.
- **S6. The window stays open after a crash.**
  - **Windows:** the script runs the server, then `if ($LASTEXITCODE -ne 0) { Read-Host "see-plan server stopped with an error (exit $LASTEXITCODE). Press Enter to close" }`. After a clean stop or an idle timeout the window closes on its own.
  - **macOS and Linux:** the same check through a tiny `sh -c` with **fixed** text; the command path and arguments are still passed as positional `"$@"` arguments, never spliced into the script.
- **S7. Startup wait and fallback.** A terminal window can take seconds to come up (Terminal.app cold start, first PowerShell profile load), so in `window`/`tmux` mode `ensureServer` waits up to **15 s** for `/health` (hidden mode keeps 5 s). If the spawn fails, the terminal binary is missing, or `/health` stays down, it starts the **hidden** server once and adds `server_window: {requested, used: "hidden", reason}` to the command's output.
  - **Late window:** if the slow window comes up afterwards, its server finds the port in use, prints "Another see-plan server is already running on :<port>; this window can be closed," and exits 0.
  - **Only the winner writes the runtime file:** `server.json` (T2) is written only after `listen` succeeds, so the server that lost never overwrites it.
- **S8. Polls survive a closed window.** Closing the window must not break an agent's wait.
  - `poll` treats `ECONNREFUSED`, `ECONNRESET` and "socket hang up" as a routine reconnect: `{status: "waiting", reconnect: true}` with the usual `next_step`. The next poll's `ensureServer` starts the server again, in a new window.
  - Queued notes are already in `state.json`, so none are lost.
  - Rule for the skill text: an agent never restarts the server by hand; it just polls again.
- **S9. Output fields.** `open`, `logs`, `error-logs`, `feature start` and bare `see-plan` add `server: {started: true|false, mode: "window"|"tmux"|"hidden", pid}` when this command started it. Bare `see-plan` also shows `server: running in a window (pid 1234)` / `running hidden` / `not running`. That way an agent can tell the user "a server window opened" instead of leaving them surprised by it.

### Phase 4: multiple outputs (problem A)

- **M1. A review session holds a list of outputs.** `session.outputs = [{id, file, kind, revision, title}]`. The session key stays the hash of the **first** (primary) file, so existing sessions, URLs and `poll <file>` keep working. A session from before 4.0 is read as `outputs: [{id: "main", file: session.file, kind}]` without rewriting `state.json` (same approach as `effectiveStage`).
- **M2. CLI:**
  - `see-plan open a.md b.mmd c.html` makes the first file primary and adds the rest.
  - `see-plan add <primary> <file...>` / `see-plan remove <primary> <output-id>` change a running session.
  - `poll <primary>` (or `poll` with any output file of the session) waits on the whole session.
  - `id` is a slug of the file name, made unique.
  - A file that is already the primary of another session is refused (`OUTPUT_IN_OTHER_SESSION`), so one file never has two reviews.
  - Max 12 outputs per session.
- **M3. Kinds and renderers**, all served under the T6 capability prefix and all **bundled** (no CDN):

| kind | extensions | rendering | annotation |
| --- | --- | --- | --- |
| `html` | `.html .htm` | as today, sandboxed | click / select, plus Interact mode (M4) |
| `markdown` | `.md .markdown` | existing `.md` → `.html` conversion | click / select |
| `mermaid` | `.mmd .mermaid`, plus `mermaid` code blocks inside Markdown | bundled `mermaid` (pinned; esbuild bundle in `public/vendor/`), rendered inside the sandboxed frame with `securityLevel: "strict"` | click a node (selector = node id) |
| `image` | `.png .jpg .jpeg .gif .webp .svg` | `<img>` in a wrapper page. **SVG is served as `image/svg+xml` inside `<img>` only**, never inlined, so its scripts don't run | click a point or drag a box → `target: {x%, y%, w%, h%}` |
| `text` | `.txt .log .json .csv` | `<pre>` with line numbers; `.csv` → `<table>`, max 5,000 rows; `.json` pretty-printed | click a line or row → `target: {line}` / `{row}` |

  Size cap per output: 5 MB (10 MB for images). Bigger files show a placeholder with the size.
- **M4. Interact / Annotate toggle** for `html` (fixes "no rich interactive UI"). The panel gets a two-state switch. In **Interact** mode, `sdk.js` removes its capture listeners (no `preventDefault`), so prototypes work normally. Text selection still offers *Comment*, and `Alt`-click still annotates. In **Annotate** mode it behaves as today. The default is Annotate, remembered per output in `localStorage` (wrapped in try/catch).
- **M5. Live reload and revisions per output:** `artifact-watcher.js` watches every output file (one chokidar watcher, many paths), and `revisions.js` stores `revisions/<key>/<output-id>/<n>.*`. The "changed blocks" outline only applies to `html`/`markdown`.
- **M6. Feedback shape:**
  - Every prompt gets `output: {id, file, kind}`.
  - `next_step` groups the prompts by output ("2 notes on `flow.mmd`, 1 on `proto.html`").
  - The DOM snapshot in poll output covers only outputs that have notes.
  - JSON and TOON both carry it.
  - A 3.x-style prompt (no `output`) means the primary.
- **M7. Guidance:** `see-plan playbook` gets `multi` (when to split work into several outputs), and `design` mentions Mermaid and image outputs. SKILL.md shows the `open a b c` form.

## Tasks

Order: **1 → 2 → 3 → 4**. Phase 2 needs Phase 1 (the runtime dir). H5 needs Phase 2. Phase 4 needs T6 (capability URLs). Each task ends with `npm test` green; tasks touching the server also run `npm run smoke` and `npm run smoke:workflow`. Phase ends also run `npm run build:sea && npm run smoke:bin`.

### Phase 1: standard paths

- **1.1 `src/paths.js`** (P1–P3). Pure function, no I/O beyond `existsSync` of the legacy folders (injectable).
  - Tests (`test/paths.test.js`): a table of platform × env cases: the XDG vars set, unset and relative; `LOCALAPPDATA` missing (fall back to `~/AppData/Local`); a legacy folder present while the new one is missing; env overrides beating everything.
- **1.2 Wire it in.**
  - `configOf` (`src/cli.js:33`) returns `resolvePaths` output.
  - `createServer` gets `errorLogFile` and `logDir`.
  - `server.log` moves to `logDir`.
  - `errorLogStep`, `logs-page.js`, the `/claude` dialog text and the `error-logs` `next_step` show the real path.
  - `/health` drops `state_dir` (also needed for T5).
  - Tests: existing tests pass with `MY_LAVISH_STATE_DIR`. A new test checks that no file under `src/` contains `".my-lavish-axi"` or `"claude-errors"` except `paths.js` (a grep test).
- **1.3 `see-plan paths [--json]`** and the `legacy_paths` line in bare `see-plan`.
- **1.4 `see-plan migrate [--dry-run]`** (P4). Tests: a temp home with legacy data → the copy is checked, the old folders are renamed, a second run refuses, `--dry-run` writes nothing, and a running server is stopped first.
- **1.5 Docs:** README Environment variables table (the defaults column now says "platform standard; see `see-plan paths`"), new `MY_LAVISH_DATA_DIR`, and SKILL.md (P5). Install scripts don't change: `~/.see-plan/bin` is the binary, not state (Q2).

### Phase 2: local auth token

- **2.1 Token and runtime file** (T2): `src/auth.js` with `createToken`, `writeRuntimeFile`, `readRuntimeFile`, `safeEqual`, `capFor(key)`. Tests: the file mode is `0600` on POSIX (skipped on win32), the write is atomic (no partial file seen by a concurrent reader), and a stale pid is detected.
- **2.2 Middleware and WebSocket** (T5).
  - Tests in `test/server-core.test.js`: each route group without credentials → 401 `AUTH_REQUIRED`; with bearer → OK; with cookie → OK; wrong token of the same length → 401 (timing-safe path); `/health` and static assets stay open.
  - WebSocket upgrade without the cookie → 401. A route list test fails when a new `app.get/post` isn't covered or explicitly exempted.
- **2.3 CLI and login link** (T3, T4): bearer on every request, `POST /api/auth/nonce`, `/auth` redirect (refuse an absolute or `//` `next`), and `see-plan url`. Tests: the nonce works once and expires after 60 s, `next=https://evil` → 400, and the cookie flags are as specified.
- **2.4 Capability artifact URLs** (T6) and the iframe `src` in `chrome-page.js`. Tests: the wrong cap → 404; relative assets resolve. **Check in a real browser** (Chrome and Firefox, via the `run` skill or claude-in-chrome): images and CSS inside the sandboxed artifact load, live reload still works, and the SDK `postMessage` path still works.
- **2.5 Smoke scripts** (`scripts/smoke.js`, `smoke-workflow.js`): read `server.json` from their private runtime dir and send the bearer. Add a smoke step: a header-less `curl`-style POST to `/api/claude-errors` → 401.
- **2.6 README:** replace "Every local process is trusted…" with the T1 threat model and the `see-plan url` workflow. CHANGELOG "Breaking".

### Phase 3: headless Connect Claude

- **3.1 `src/environment.js`** (H1). Tests: a table of env/fs fixtures for SSH, Codespaces, Docker, WSL, tmux, a plain Linux desktop, macOS over SSH, and Windows.
- **3.2 Send the environment from the CLI** (H2): the `X-See-Plan-Env` header is size-capped (2 KB), schema-validated and stored per session in memory only (not in `state.json`).
- **3.3 Launch strategies** (H3) in `claude-launcher.js`: `chooseStrategy(env, config)`, `buildTmuxLaunch`, and expanding the custom terminal argv. `claudeStatus` returns `{launch, strategy_reasons}`.
  - Tests: the strategy chosen per fixture, tmux argv (no shell string; a prompt with quotes and `$()` passes through as one argv item), bad `MY_LAVISH_TERMINAL` values refused, and `off` hiding the button.
- **3.4 Browser opening** (H4): `openUrl` never throws on spawn failure, and the CLI skips it when `gui` is false. Tests with a fake `spawnFn` that emits `error`.
- **3.5 Panel copy** (`public/chrome-client.js` L320–400): tmux success text, the *unsupported* card now explaining *why* (headless, no display), and stuck hints (H6).
- **3.6 Allowed hosts** (H5), only after Phase 2. Tests: `MY_LAVISH_ALLOWED_HOSTS` without a token is impossible by construction; an unlisted host → 403; a listed host without a cookie → 401.
- **3.7 Smoke in a headless container:** a CI job (`.github/workflows/ci.yml`) running `npm run smoke` in `node:22` with no `DISPLAY` and `MY_LAVISH_LAUNCHER` unset. It checks that bare `see-plan open --json` reports `opened: false` and that `/api/claude-status` reports `copy`, and that the server started `hidden` (`server.mode`).
- **3.8 Graceful shutdown** (S5), before any window work, because it is useful on its own.
  - Code: one `shutdown(reason)` in `server.js` shared by signals, `/shutdown` and the idle timeout.
  - Tests: a waiting poll gets `reconnect: true`; WebSockets close with 1001; a pending `transact` finishes before exit; `server.json` is removed only when its pid matches; a second signal during shutdown forces exit after 3 s.
- **3.9 Poll reconnects when the server goes away** (S8).
  - Tests in `test/cli.test.js` with a fake server that resets the socket mid-poll → `waiting` + `reconnect: true`, exit code 0.
  - The `smoke.js` step kills the server during a poll, polls again, and sees the queued note.
- **3.10 Server window launch** (S1–S3, S6, S7) in a new `src/server-launcher.js`, reusing `claude-launcher.js` builders (factor out a shared `buildTerminalLaunch({argv, title, cwd, env, keepOpenOnError})`). Tests with a fake `spawnFn`:
  - **Chosen mode per fixture:** desktop → window, tmux → tmux, SSH/CI/container → hidden.
  - **No shell strings:** a path with spaces, quotes and `$()` stays one argv item on all three OSes.
  - **Environment:** the passed variables match the S3 allowlist exactly.
  - **Fallback:** spawn `error` → falls back to hidden once; `/health` never coming up within 15 s → falls back to hidden; a late second server exits 0 and doesn't overwrite `server.json`.
- **3.11 Console log format** (S4): a `createConsoleLog({tty})` used by `log()` in `server.js`.
  - **Leak test:** run a full smoke flow with stdout captured, then assert the output never contains the token, a nonce, the cookie value, or note/transcript text.
  - **Countdown test:** the idle countdown lines appear with a fake clock.
- **3.12 Output fields** (S9): `server` block on the listed commands, bare `see-plan` status line, and SKILL.md wording ("If a see-plan server window opened, leave it open; closing it stops reviews until the next see-plan command restarts it.").
- **3.13 Smoke and manual check.**
  - **Smoke:** `smoke.js`, `smoke-workflow.js` and `smoke:bin` set `MY_LAVISH_SERVER_WINDOW=hidden` so CI never opens windows.
  - **Manual check on Windows 11 (this machine) and, if available, macOS and a Linux desktop:**
    1. The first `see-plan examples/plan.html` opens the server window with the banner.
    2. A second command reuses it (no new window).
    3. Closing the window during a `poll` makes the poll return `reconnect: true`.
    4. The next poll opens a fresh window.
    5. An induced crash (port taken by a non-see-plan app) leaves the window open with the error.
  - **Evidence:** save screenshots to `docs/evidence/`.

### Phase 4: multiple outputs

- **4.1 Store model** (M1): `outputs` in `session-store.js`, the read-time upgrade of old sessions, and `addOutput`/`removeOutput` under `store.transact`. Tests: an old session is read as one output, ids are unique, the cap of 12, and `OUTPUT_IN_OTHER_SESSION`.
- **4.2 CLI** (M2): `open` with many files, `add`, `remove`, and poll by any output file. Tests in `test/cli.test.js`.
- **4.3 Kinds and renderers** (M3): `src/outputs.js` (kind detection, size caps, wrapper pages for image and text), bundling Mermaid into `public/vendor/mermaid.min.js` at build (`scripts/build-sea.js` must embed it; check the SEA size before and after and note it in the CHANGELOG), and `THIRD_PARTY_LICENSES` regenerated.
  - Tests: kind detection, a CSV with quotes/newlines and with more than 5,000 rows, SVG served only as an image (the wrapper never inlines it), and a file over the cap shown as a placeholder.
- **4.4 Panel tabs:** one tab per output (keyboard like `/errors`: arrows, Home/End), a badge with the note count per tab, and an "added" toast when `add` runs live.
- **4.5 SDK annotation per kind:** image region select, text line/row select, Mermaid node click, and the **Interact/Annotate toggle** (M4). Tests in `test/public-assets.test.js` for the toggle state machine. Check in a real browser: a sample prototype `examples/prototype.html` (a form with buttons and a modal) works in Interact mode, and Alt-click annotates.
- **4.6 Watcher and revisions per output** (M5).
- **4.7 Poll output** (M6): grouping in `next_step`, `output` on prompts, snapshots only for outputs with notes. Tests: TOON and JSON, plus 3.x prompts without `output`.
- **4.8 Guidance and docs** (M7): the `multi` playbook, `examples/multi/` (plan.md + flow.mmd + prototype.html + screenshot.png), README "Run a review with several outputs", and the README "Differences" list updated (Mermaid now supported; Excalidraw still not).
- **4.9 Smoke:** `smoke.js` opens a 3-output session, sends a note on each, and checks that poll groups them.

## Release

- **3.3.0** after Phase 1 (non-breaking, because legacy paths keep working), then **4.0.0** after Phases 2–4 (decided in Q5), so the path change is tried on its own.
- CHANGELOG "Breaking" in 4.0.0: API needs a token; 3.x CLIs must be upgraded; artifact URLs changed; `/health` no longer returns `state_dir`.

## Risks

| Risk | Mitigation |
| --- | --- |
| The cookie isn't sent inside the sandboxed artifact frame, so assets break | T6 capability URLs don't depend on cookies; Task 2.4 checks in a real browser before Phase 4 builds on it. |
| Cookies on `127.0.0.1` are shared across ports, so another local server on a different port receives them | The cookie name includes the port; the value is useless without our port; same-user processes are out of scope (T1). |
| The Mermaid bundle grows the SEA binary by several MB | Load it only for `mermaid` outputs (a separate file, not in `sdk.js`); measure in 4.3. |
| Migration while a server is running corrupts `state.json` | `migrate` stops the server first and refuses if it can't. |
| `tmux new-window` lands in the wrong tmux server/session | Use `$TMUX` from the **CLI's** environment (H2); if it's missing, use a detached `tmux new-session -d -s see-plan`. |
| Interact mode hides that the page can be annotated | The toggle is always visible; Alt-click and *Comment on selection* work in both modes. |
| The server window steals focus from the user's or agent's terminal | Accepted (Q7: a normal window by default). It opens only when the server isn't already running (at most once per idle period); tmux windows open detached (`-d`); `MY_LAVISH_SERVER_WINDOW=hidden` turns it off. |
| The user closes the server window mid-review and thinks the review is lost | S5 ends the server cleanly, S8 makes polls reconnect, the next command reopens the window, and notes are already saved in `state.json`. |
| The terminal starts a fresh shell, so the window runs a different server (other port or state folder) than the CLI expects | S3 `env` wrapper with an allowlist; the 3.10 test checks the passed variables. If `/health` on the expected port stays down, S7 falls back to hidden. |
| Two servers race for the port when a slow window appears after the hidden fallback | The port bind decides the winner; the loser exits 0 with a message and never writes `server.json` (S7). |

## Open questions (each has a recommended answer)

All questions were decided on 2026-11-04.

- **Q1. Decided:** "takes multiple output" means **several outputs (files) per review session**, as Phase 4 describes. The CLI's output formats (`--json`, TOON) stay as they are.
- **Q2. Decided:** the installers **don't move the binary** in this plan. It stays in `~/.see-plan/bin`; moving it is a later installer release.
- **Q3. Decided:** on Windows, `server.json` gets a **user-only ACL** set with the absolute `System32\icacls.exe` path, as the launcher does. If `icacls` fails, the server logs a warning and keeps running (part of Task 2.1).
- **Q4. Decided:** **no auth bypass**, not even for tests. Tests and smoke runs use the real token (T8).
- **Q5. Decided:** **two releases**: 3.3.0 after Phase 1 (paths), then 4.0.0 after Phases 2–4.
- **Q6. Decided:** the error log keeps the name **`error-log.json`** in the new data folder.
- **Q7. Decided 2026-11-04:** the server window **opens by default** (`auto`) on a desktop, in a normal (not minimized) window. It opens at most once per server lifetime, and `MY_LAVISH_SERVER_WINDOW=hidden` brings back the old behaviour.
- **Q8. Decided 2026-11-04:** the server window **does not show a sign-in link**, because its text can be seen by screen sharing and terminal scrollback. Its banner says "run `see-plan url`" instead (S4).

## Implementation notes (2026-11-08)

- **M2 changed:** the first .html or .md file is the primary, not the first file, because the session key needs a page. A review with no .html or .md file is refused.
- **Windows launch changed from S3:** both windows open through a hidden PowerShell that calls `Start-Process`, because Node's `detached` has no console on Windows.
- **Checked in real Chrome (headless), on Windows:** sign-in, tabs, Mermaid, images, CSV, Interact mode, Alt-click and tagged notes. Firefox (Task 2.4) was not checked.
- **Checked on Windows 11:** the server window opens with its title; killing the server during a poll gives `reconnect: true`.
- **Not checked:** macOS and Linux desktop windows, closing the window by hand, and Connect Claude actually launching in the new console.
