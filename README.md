# my-lavish-axi

A CLI built for AI agents. The agent writes an HTML artifact (a plan, diagram, table, report) and runs `see-plan <file.html>`. A local browser page opens; the human clicks elements or selects text to leave notes, chats, and presses **Send to Agent**. Meanwhile the agent waits in `see-plan poll <file.html>`, which returns the feedback as structured data.

This is a small re-implementation of the core loop of [lavish-axi](https://github.com/kunchenguid/lavish-axi).

## What problems it solves

- **Chat is a poor place to review a plan.** Long plans, comparisons, and diagrams scroll away in a terminal. Here the agent shows them as a real web page the human can read at a glance.
- **Feedback on "that part" is hard to give in text.** Saying "the third step in section 2" is slow and easy to get wrong. The human clicks the exact element or selects the exact text, and the note arrives with its CSS selector and text attached, so the agent knows what it refers to.
- **The agent has no way to wait for a person.** `poll` blocks until the human presses **Send to Agent** (or ends the session), then returns the feedback as structured data with a `next_step`. The agent does not have to guess when the human is done.
- **Revisions are hard to follow.** When the agent edits the HTML, the page reloads in place and the agent's reply appears in the same chat, so the review stays in one place across rounds.
- **No accounts, no cloud.** Everything runs on `localhost`; state is one JSON file on your machine.

## Running the project

### Install

**1. One-line installer (recommended)** — downloads the latest release, checks its SHA-256, installs to `~/.see-plan/bin`, and puts it on your PATH. No Node.js needed.

```powershell
# Windows (PowerShell)
irm https://github.com/AliA1997/my-lavish/releases/latest/download/install.ps1 | iex
```

```sh
# macOS / Linux
curl -fsSL https://github.com/AliA1997/my-lavish/releases/latest/download/install.sh | sh
```

To also install the Claude Code skill (`~/.claude/skills/my-lavish`): set `$env:SEE_PLAN_INSTALL_SKILL = "1"` before the PowerShell line, or append `-s -- --install-skill` to `sh`. Open a new terminal, then run `see-plan --version`.

**2. Manual download** — grab `see-plan-<platform>.zip|tar.gz` from [Releases](https://github.com/AliA1997/my-lavish/releases), check it against `SHA256SUMS`, and put `see-plan` on your PATH. Builds: Windows x64, Linux x64, macOS arm64, macOS x64.

> **Windows SmartScreen:** the executable is not code-signed yet, so Windows may warn "Windows protected your PC" the first time. Choose **More info → Run anyway**, or install with npm instead. macOS builds are ad-hoc signed; if Gatekeeper blocks one, run `xattr -d com.apple.quarantine ~/.see-plan/bin/see-plan`.

**3. npm** (needs Node.js 22+): `npm install -g github:AliA1997/my-lavish`

**4. From source** (needs Node.js 22+ and npm):

```
npm install
npm link        # puts `see-plan` on your PATH; or run `node bin/see-plan.js <args>`
```

Upgrading from 0.1: the command was renamed, so run `npm unlink -g my-lavish-axi` once.

A browser is needed only for the human side; use `--no-open` to skip launching it.

### Quick start

```
npm install
npm test                                   # optional: unit tests
node bin/see-plan.js examples/plan.html    # opens the page (or `see-plan ...` after npm link)
node bin/see-plan.js poll examples/plan.html   # in a second terminal: waits for your feedback
node bin/see-plan.js stop                  # when done
```

To see your Claude sessions, run `see-plan` with no file in a terminal (or `see-plan logs` from anywhere). The browser opens the **Claude log page** at `http://127.0.0.1:4388/claude`. No plan is shown. The top line is the newest Claude Code session's id and the date of its last prompt, and the page below is that session's log, updating live. **Recent sessions** switches to any of your 20 latest sessions. Click an entry to log it as an error: a dialog shows the entry, asks you to pick a **severity** and *Why is this an error?*, and **Log as error** adds it to the error log (`see-plan paths` shows where). `see-plan error-logs` lists everything logged (see [Error logs](#error-logs)).

To attach a session from the command line instead, pass its id (the file name of a `~/.claude/projects/<project>/<id>.jsonl`):

```
see-plan examples/plan.html --claude-session <session-uuid>
```

If the session was ended earlier, add `--reopen`. Use `--no-open` to skip the browser.

### Try it

```
see-plan examples/plan.html
```

A browser page opens with the example plan. Then, in another terminal (or as the agent):

```
see-plan poll examples/plan.html
```

Click something on the page, add a note, press **Send to Agent**, and the poll returns it. Reply and wait again with:

```
see-plan poll examples/plan.html --agent-reply "Updated step 2."
```

Finish with `see-plan end examples/plan.html`, and `see-plan stop` to shut down the background server.

### Use it from an agent

Copy `skills/my-lavish/` into your agent's skills folder (for Claude Code: `~/.claude/skills/my-lavish/`). The installers do this with `-InstallSkill` / `--install-skill`. The skill tells the agent how to poll (and re-poll every 1:50), to follow each `next_step`, and how the four stages work.

### Run a feature through four stages

```
see-plan feature start export-csv --requirements reqs.md --with-claude
```

This writes `export-csv.requirements.md` and a placeholder `export-csv.plan.md`, opens the Plan stage, and starts Claude to write the plan. Each stage has its own page and its own fresh Claude session:

| Stage | Page you review | Claude's job | Done when |
| --- | --- | --- | --- |
| Plan | `<name>.plan.md` | Write the plan from the requirements | You press **Approve plan** |
| Interrogation | `<name>.interrogation.html` | Ask numbered questions with recommended answers, then update the plan | You approve |
| Implementation | `<name>.progress.html` | Build task by task, keeping the progress page current | You approve |
| Verification | `<name>.verification.html` | Check each criterion with evidence; no fixes | You press **Accept**, or **Request changes** to send it back to Implementation |

After an approval, the panel shows **Start <next stage> →**: one click opens the next page and launches a fresh Claude for it. **Skip to next stage** moves on without approval. The dashboard at `http://127.0.0.1:4388/` (or **New feature** there) shows every feature's progress.

### Tests

```
npm test                # unit tests
npm run smoke           # full loop against a throwaway server; prints SMOKE OK
npm run smoke:workflow  # all four stages with a fake Claude; prints WORKFLOW SMOKE OK
npm run build:sea       # builds dist/see-plan[.exe], a standalone executable
npm run smoke:bin       # the full loop against that executable
```

## How it works

```
 agent writes HTML
        |
        v
 see-plan <file>  --->  detached local server + browser page opens
        |                                   |
        v                                   v
 see-plan poll <file>          human annotates, chats,
   (blocks, silent)  <---- feedback ----  presses "Send to Agent"
        |
        v
 agent edits the HTML (page live-reloads)
        |
        v
 poll <file> --agent-reply "..."  --->  reply shows in the chat; loop repeats
        |                                until someone ends the session
```

One background server is started on demand and reused by later commands. A session is identified by the file path. State is kept in `state.json` in the state directory.

## CLI reference

| Command | What it does |
| --- | --- |
| `see-plan` | Lists known sessions and usage. Run in a terminal, it also prints the Claude log page URL and the `error_logs` URL for the current folder (it never opens a browser) |
| `see-plan <file.html|file.md>` / `open <file>` | A `.md` plan is converted to a sibling `.html` (regenerated when the `.md` is newer, never over a hand-written `.html`); agents edit the `.md`. Opens (or reopens) the session and the browser. A session the user ended is refused unless `--reopen` is given |
| `poll <file>` | Blocks until the user sends feedback or ends the session; prints prompts, `next_step`, and a DOM snapshot |
| `poll <file> --agent-reply "<text>"` | Posts a reply to the chat, then polls |
| `reply <file> --agent-reply "<text>"` | Posts a reply without polling |
| `end <file>` | Ends the session |
| `status <file>` | Read-only: status, stage, whether an agent is listening, queued notes. Never takes feedback |
| `stage <file> [name]` | Reads or sets the stage label (`plan`, `interrogation`, `implementation`, `verification`, `none`) |
| `feature start <name> --requirements <file\|->` | Starts a four-stage feature in `--dir` (default: the current folder) |
| `feature status <name>` | The feature's stages and current stage |
| `prune` | Removes sessions whose file no longer exists (`--dry-run` lists them) |
| `logs` | Opens the Claude log page (newest Claude session's log) in the browser; with `--no-open`, prints its URL |
| `error-logs` | Opens the error-log tabs for the current folder (`--dir` for another). In a project: Session and Plan Error Logs, its superpowers plans and Sessions. Elsewhere: only recent Sessions. See [Error logs](#error-logs) |
| `stop` | Stops the background server |
| `design` | Prints the design rules for artifacts |
| `playbook [id]` | Lists playbooks, or prints one (`plan`, `diagram`, `table`, `comparison`, `input`, `interrogation`, `progress`, `verification`) |
| `server` | Runs the server in the foreground (normally started automatically) |

Flags: `--json` (JSON instead of TOON text), `--no-open` (do not launch a browser), `--reopen`, `--with-claude` (on open or feature start: also start Claude in a new terminal), `--stage <name>` (on open/poll: label the stage), `--agent` (poll as an agent outside Claude Code: 1:50 cycles), `--claude-session <uuid>` (on open/poll: tell the panel which Claude session to show; inside Claude Code, poll fills it in on its own), `--agent-reply <text>`, `--agent-reply-file <path|->`, `--timeout-ms <n>` (poll returns `waiting` after this long), `--help`, `--version`.

Every output includes a `next_step` telling the agent what to do next.

**Staying connected.** An agent's poll (inside Claude Code, or with `--agent`) returns on its own about every **1 min 50 s** with `status: waiting` and `reconnect: true`, which is under Claude Code's default 120 s Bash timeout, so the tool never kills it. The agent simply runs the same poll again. The server also caps agent polls at 1:50 for older CLIs. The panel keeps showing "connected" through these cycles: presence stays connected for a 20 s grace period after each poll ends, notes sent in the gap are handed to the next poll, and Connect Claude is refused (`AGENT_RECONNECTING`) so a second Claude is never started.

## Working with Claude from the page

- **Connection card** at the top of the panel shows one state at a time: *No agent connected* (with **Connect Claude**, **Resume last session** when there is an earlier Claude conversation, and *How do I connect manually?*), *Starting Claude… 0:12* (with **Cancel**), *connected — waiting for your feedback*, *working on your feedback*, *stuck* (no poll after 45 s: check the Claude window for a folder-trust, login, or permission prompt; **Copy allow-rule** copies `"Bash(see-plan:*)"` for `.claude/settings.json`), and *unsupported* (a command to paste). Hover the connected card to see the last check-in.
- **Connect Claude** opens a terminal in the plan's repo root and starts `claude --session-id <uuid>` with a labeled prompt (`[see-plan · <feature> · <Stage>] …`). Windows uses PowerShell (needs the native `claude.exe`), macOS uses Terminal, Linux uses the first of x-terminal-emulator, gnome-terminal, konsole, xterm. If none is available, the card shows the command to paste. Paths and prompts never go through a shell string. see-plan never passes a permission-bypass flag.
- **Session feedback** (on the card): 👍/👎, categories (*Wrong direction*, *Too slow*, *Broke something*, *Ignored my notes*, *Great job*) and a note. It reaches the agent on its next poll and is logged to `feedback.jsonl` in the state directory.
- **Approve / Request changes** sit above the composer for plans and staged sessions. Approve ends the session as *approved* (and, in a feature, opens the next stage). **⋯ More** holds *Comment on the whole plan*, *Send & End* and *End session*; ending asks first. After a session ends, **Resume (keep history)** reopens it and **Start fresh** clears the chat (earlier rounds stay under *Previous rounds*).
- **Revision rN ▾** lists the last 20 versions of the page; pick one to view it read-only. After each reload the blocks that changed are outlined for 10 s.
- **Stage menu** in the header labels the session. A label inferred from your words or the file name shows *(inferred) · Confirm*; inference never overrides a label you or the agent set.
- **Claude log** tab shows that session's transcript (`~/.claude/projects/*/<session-id>.jsonl`, or `$CLAUDE_CONFIG_DIR`). A Claude agent's poll attaches its own session when none is attached yet (it never replaces one you picked); `--claude-session <uuid>` always sets it. Each refresh reads at most 256 KB and the tab keeps the last 500 entries.
- With no session attached, or one with no transcript (such as a Connect Claude launch that never started), the tab lists the **20 most recent Claude sessions**, newest first. Each is titled by its `/rename` title or first prompt; built-in commands such as `/clear` or `/model` are skipped. Click one to show its log, or paste an id. **Change session** reopens the list.
- **Click a log entry** to open a small note box: **Send to agent** (a `claude-log` note with your text), **Log as error** (the server appends it to the error log with the severity you pick in the box, and your text saved as the `reason`), or **Both**. *Log as error* and *Both* need a severity; High and Send to IT also need a note. The agent is never asked to write files. A sent entry is marked. Select text inside an entry to copy it instead.
- **Claude log page** (`/claude`, opened by `see-plan logs`): the newest Claude session's id and last-prompt date on top, its log below, and a **Recent sessions** menu for the other 19. The log loads at least 200 entries when the session has that many (reading up to 16 MB back), then updates live. Add `?id=<uuid>` to the URL to open a given session. No agent is involved here: clicking an entry opens a confirmation dialog with a preview, a required **severity** (keys 1–4 pick one) and a reason (up to 2,000 characters; required for High and Send to IT). **Log as error** (or Ctrl/Cmd+Enter) makes the server append it (session id, line `uuid`, part, role, kind, time, text, `reason`, `severity`, `context`, `review_key`, `stage`, `reported_at`) to the error log itself (`see-plan paths` shows where); Esc cancels. Clicking an entry that is already logged shows its saved reason and severity, read-only: the first ones are kept. Logged entries carry a severity badge. The page header links to the dashboard and the **Error logs** page. It creates the file if missing, keeps the records already there, skips an entry that is already logged, and refuses to touch a file that is not a JSON array.
- **What the token protects.** The server makes a new secret token at each start and keeps it in a file only your user can read (`server.json` in the runtime folder; see `see-plan paths`). The CLI sends it on every call, and the browser signs in through a one-time link that sets a cookie. Run `see-plan url` to get a link. This stops other OS users on the machine, sandboxed or containerised processes that can reach `127.0.0.1` but can't read your files, and attacks from websites. It does **not** stop malware already running as you: that can read the token file, and everything else you own.

## Several outputs in one review

```
see-plan open plan.md flow.mmd prototype.html screenshot.png results.csv
```

The page shows one tab per file, and the first `.html` or `.md` file is the primary. Try it with the files in `examples/multi/`. A review holds up to 12 outputs; add or take them out while it runs with `see-plan add <primary> <file...>` and `see-plan remove <primary> <output-id>`.

| Kind | Files | Notes you can leave |
| --- | --- | --- |
| HTML | `.html` `.htm` | Click or select. **Mode: Interact** (Ctrl+I) lets clicks reach the page so prototypes work; Alt-click still takes a note |
| Markdown | `.md` `.markdown` | Click or select; `mermaid` code blocks are drawn |
| Mermaid | `.mmd` `.mermaid` | Click a node |
| Image | `.png` `.jpg` `.gif` `.webp` `.svg` | Click a point or drag a box (percent of the image) |
| Text | `.txt` `.log` `.json` `.csv` | Click a line, or a row for `.csv` |

Everything renders locally, with no CDN. Files over 5 MB (10 MB for images) show a placeholder. Polling any output waits on the whole review. Each prompt has `output: {id, file, kind}`, and each file live-reloads and keeps its own revisions.

## Starting the server, and running without a desktop

When a command has to start the server, it opens in **its own terminal window** with a live log. Closing that window, pressing Ctrl+C or running `see-plan stop` stops it; the next command starts it again, and queued notes are kept. Inside tmux it opens as a background tmux window. Over SSH, in containers and in CI it runs hidden, logging to `server.log`.

With no desktop, see-plan prints the URL instead of opening a browser: forward the port (`ssh -L 4388:127.0.0.1:4388 <host>`), then run `see-plan url` and open the link. Connect Claude uses a terminal window, then tmux, then shows a command to copy.

## Error logs

Run **`see-plan error-logs`** (or `--dir <path>`) to open the error-log view for the folder you are in. Bare `see-plan` in a terminal prints the same link as `error_logs`. What you see depends on where you start it:

- **In a project folder**, meaning the nearest folder above you that has `.git`, `docs/superpowers/` or `.superpowers/` (your home folder never counts), the page (`/errors?project=<key>`) has **four tabs**.
- **Anywhere else**, the page (`/errors`) shows **only the Sessions tab**, plus links to projects you opened before.

The URL keeps the open tab (`#session-errors`, `#plan-errors`, `#plans`, `#sessions`), and the arrow keys, Home and End move between tabs.

- **Session Error Logs**: errors logged from ordinary sessions, with severity, the entry (expandable to its full text), the reason, the Claude session and when it was logged. Chips filter by severity; **Load more** pages by 50.
- **Plan Error Logs**: the same, for errors logged from a planning session (a Claude session attached to a review session whose stage is Plan), plus the plan file.
- **Plans**: the 50 most recently created **superpowers plans** in the project's `docs/superpowers/plans/` (dated by their `YYYY-MM-DD-` prefix, otherwise by file creation time), with title, status (Not opened, Open, Needs changes, Approved, Ended, Archived) and error counts. **Open** starts a review session for a plan that isn't open yet.
- **Sessions**: the 75 most recent Claude sessions, with the attached review session and stage and their error counts.

Each error has a severity:

| Severity | Meaning | Color | Reason |
| --- | --- | --- | --- |
| Low | Minor miscommunication between the human and the AI. | Orange | optional |
| Medium | Wrote buggy code, or a plan that was slightly off course. | Amber | optional |
| High | A plan that went badly off course; a sign of lost context ("lost in the middle"). | Red | required |
| Send to IT | Malicious code, or work that ran without supervision. | Red velvet | required |

Whether an error is a plan or a session error is worked out by the server when it is logged, from the Claude session id alone. Records logged before severities existed (0.2.x) show as **Unrated**; each can be given a severity once with **Rate…**. *Send to IT* is a label only: nothing is sent anywhere. Records are otherwise never edited.

## Where see-plan keeps its files

see-plan follows each platform's standard folders. `see-plan paths` (or `see-plan paths --json`) prints every path and the rule that chose it (`env`, `legacy` or `default`); agents should read the error log path from there instead of guessing it.

| | Linux / other POSIX | macOS | Windows |
| --- | --- | --- | --- |
| state (`state.json`, `revisions/`, `feedback.jsonl`) | `$XDG_STATE_HOME/see-plan` (`~/.local/state/see-plan`) | `~/Library/Application Support/see-plan` | `%LOCALAPPDATA%\see-plan\state` |
| data (`error-log.json`) | `$XDG_DATA_HOME/see-plan` (`~/.local/share/see-plan`) | `~/Library/Application Support/see-plan` | `%LOCALAPPDATA%\see-plan\data` |
| logs (`server.log`) | the state dir | `~/Library/Logs/see-plan` | `%LOCALAPPDATA%\see-plan\logs` |
| runtime (`server.json`) | `$XDG_RUNTIME_DIR/see-plan`, else the state dir | the state dir | `%LOCALAPPDATA%\see-planun` |
| config (`config.json`, optional) | `$XDG_CONFIG_HOME/see-plan` | `~/Library/Application Support/see-plan` | `%APPDATA%\see-plan` |

On macOS, `XDG_*` variables you set explicitly win over `~/Library`. A relative `XDG_*` value is ignored.

**Upgrading from 3.2 or earlier.** Older versions used `~/.my-lavish-axi` and `~/claude-errors/error-log.json`. While those exist and the new folders don't, see-plan keeps using them, so nothing is lost; bare `see-plan` then prints `legacy_paths: run see-plan migrate`. `see-plan migrate --dry-run` shows what would move; `see-plan migrate` stops the server, copies the data, checks it (the JSON parses, the session and record counts match), and renames the old ones to `*.migrated-<date>`. It never deletes them, and it refuses when the new location already has data.

**Several isolated servers** (for example one per project): give each its own `MY_LAVISH_STATE_DIR` and `MY_LAVISH_PORT`, e.g. `MY_LAVISH_STATE_DIR=~/.see-plan-work MY_LAVISH_PORT=4390 see-plan plan.md`.

## Environment variables

None are required; the defaults work out of the box. Set them only to change the behavior below.

| Variable | Default | Meaning |
| --- | --- | --- |
| `MY_LAVISH_PORT` | `4388` | Server port |
| `MY_LAVISH_STATE_DIR` | platform standard; see `see-plan paths` | Holds `state.json`, `revisions/` and `feedback.jsonl`. Setting it also moves `server.log` and the runtime file `server.json` there, so an isolated server never reads another one's token |
| `MY_LAVISH_DATA_DIR` | platform standard; see `see-plan paths` | Holds `error-log.json` |
| `MY_LAVISH_SERVER_WINDOW` | `auto` | `auto`, `window`, `tmux` or `hidden`: how a started server is shown |
| `MY_LAVISH_LAUNCHER` | `auto` | `auto`, `terminal`, `tmux`, `copy` or `off`: how Connect Claude starts Claude |
| `MY_LAVISH_TERMINAL` | unset | A JSON argv array for your terminal, such as `["wezterm","start","--","{cmd...}"]` |
| `MY_LAVISH_ALLOWED_HOSTS` | unset | Extra exact host names for a port forwarder. The token is still required |
| `USE_ERROR_SEARCH` | unset | `true` turns on `see-plan errors similar` and `errors store` (experimental) |
| `USE_PINECONE` | unset | `true`, with `PINECONE_API_KEY` set, stores errors in Pinecone instead of the local file and turns on error search (experimental). Error text leaves this machine |
| `MY_LAVISH_NO_OPEN` | unset | `1` = never launch a browser (same as `--no-open`) |
| `MY_LAVISH_IDLE_TIMEOUT_MS` | `1800000` | Server exits after this long with no WebSocket or poll connections; `0` or `off` disables |
| `MY_LAVISH_ERROR_LOG` | `<data dir>/error-log.json` | Where the server writes logged errors (wins over `MY_LAVISH_DATA_DIR`) |

Example (PowerShell): `$env:MY_LAVISH_PORT = "5000"; see-plan examples/plan.html`
Example (bash): `MY_LAVISH_PORT=5000 see-plan examples/plan.html`

## Differences from lavish-axi

Left out on purpose, to keep only the core loop:

- Tailscale / phone access
- Excalidraw whiteboards (Mermaid diagrams are supported as outputs)
- Layout-issue audit
- Image attachments
- Export and sharing
- Telemetry
- Plugin and hook setup
- Self-update
- Revisions legend

Built-in guidance is limited to the `design` text and five playbooks (`plan`, `diagram`, `table`, `comparison`, `input`).

## License

MIT. See [LICENSE](LICENSE). Release archives also include `THIRD_PARTY_LICENSES.txt` (every bundled dependency, plus Node.js, which the standalone executable embeds).

**Credits:** see-plan is an independent re-implementation of the core review loop of [lavish-axi](https://github.com/kunchenguid/lavish-axi) by Kun Chen (MIT). See [NOTICE](NOTICE).
