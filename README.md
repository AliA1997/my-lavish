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

### Requirements

- Node.js 22 or newer (`node --version`)
- npm
- A browser (only needed for the human side; use `--no-open` to skip launching it)

### Install

```
npm install
npm unlink -g my-lavish-axi; npm link   # puts `see-plan` on your PATH (the command was renamed)
```

`npm link` now puts `see-plan` (not `my-lavish-axi`) on your PATH. Without it, run it directly: `node bin/see-plan.js <args>`.

### Quick start

```
npm install
npm test                                   # optional: unit tests
node bin/see-plan.js examples/plan.html    # opens the page (or `see-plan ...` after npm link)
node bin/see-plan.js poll examples/plan.html   # in a second terminal: waits for your feedback
node bin/see-plan.js stop                  # when done
```

To see your Claude sessions, run `see-plan` with no file in a terminal (or `see-plan logs` from anywhere). The browser opens the **Claude log page** at `http://127.0.0.1:4388/claude`. No plan is shown. The top line is the newest Claude Code session's id and the date of its last prompt, and the page below is that session's log, updating live. **Recent sessions** switches to any of your 20 latest sessions. Click an entry to add it to `~/claude-errors/error-log.json`.

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

Copy `skills/my-lavish/` into your agent's skills folder (for Claude Code: `~/.claude/skills/my-lavish/`). The skill tells the agent to read `see-plan --help`, `design`, and `playbook <id>` for current instructions.

### Tests

```
npm test         # unit tests
npm run smoke    # full loop against a throwaway server; prints SMOKE OK
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
| `see-plan` | Lists known sessions and usage. Run in a terminal, it also opens the Claude log page (agents, which run without a terminal, only get the text) |
| `see-plan <file.html|file.md>` / `open <file>` | A `.md` plan is converted to a sibling `.html` (regenerated when the `.md` is newer, never over a hand-written `.html`); agents edit the `.md`. Opens (or reopens) the session and the browser. A session the user ended is refused unless `--reopen` is given |
| `poll <file>` | Blocks until the user sends feedback or ends the session; prints prompts, `next_step`, and a DOM snapshot |
| `poll <file> --agent-reply "<text>"` | Posts a reply to the chat, then polls |
| `reply <file> --agent-reply "<text>"` | Posts a reply without polling |
| `end <file>` | Ends the session |
| `logs` | Opens the Claude log page (newest Claude session's log) in the browser; with `--no-open`, prints its URL |
| `stop` | Stops the background server |
| `design` | Prints the design rules for artifacts |
| `playbook [id]` | Lists playbooks, or prints one (`plan`, `diagram`, `table`, `comparison`, `input`) |
| `server` | Runs the server in the foreground (normally started automatically) |

Flags: `--json` (JSON instead of TOON text), `--no-open` (do not launch a browser), `--reopen`, `--with-claude` (on open: also start Claude in a PowerShell window), `--claude-session <uuid>` (on open/poll: tell the panel which Claude session to show; inside Claude Code, poll fills it in on its own), `--agent-reply <text>`, `--agent-reply-file <path|->`, `--timeout-ms <n>` (poll returns `waiting` after this long), `--help`, `--version`.

Every output includes a `next_step` telling the agent what to do next.

**Staying connected.** An agent's poll (inside Claude Code, or with `--agent`) returns on its own about every **1 min 50 s** with `status: waiting` and `reconnect: true`, which is under Claude Code's default 120 s Bash timeout, so the tool never kills it. The agent simply runs the same poll again. The server also caps agent polls at 1:50 for older CLIs. The panel keeps showing "connected" through these cycles: presence stays connected for a 20 s grace period after each poll ends, notes sent in the gap are handed to the next poll, and Connect Claude is refused (`AGENT_RECONNECTING`) so a second Claude is never started.

## Working with Claude from the page

- **Start new session** appears in the panel after a session ends. It keeps the same file, clears the chat, and keeps any feedback the agent has not collected yet.
- **Connect Claude** (shown while no agent is polling) opens PowerShell, starts `claude --session-id <uuid>` in the plan's repo root, and tells it to run `see-plan poll`. `see-plan <file> --with-claude` does the same from the command line. Windows only; needs the native `claude.exe` on PATH. Permission prompts are Claude's own; see-plan never passes a permission-bypass flag.
- **Agent status** at the top of the panel says when an agent is connected: "Claude agent connected — waiting for your feedback" while its poll waits, and "… is working on your feedback" after it takes your notes and before it polls again. `see-plan poll` recognizes Claude Code from the `CLAUDECODE` and `CLAUDE_CODE_SESSION_ID` variables Claude Code sets, so no flag is needed.
- **Claude log** tab shows that session's transcript (`~/.claude/projects/*/<session-id>.jsonl`, or `$CLAUDE_CONFIG_DIR`). A Claude agent's poll attaches its own session when none is attached yet (it never replaces one you picked); `--claude-session <uuid>` always sets it. Each refresh reads at most 256 KB and the tab keeps the last 500 entries.
- With no session attached, or one with no transcript (such as a Connect Claude launch that never started), the tab lists the **20 most recent Claude sessions**, newest first. Each is titled by its `/rename` title or first prompt; built-in commands such as `/clear` or `/model` are skipped. Click one to show its log, or paste an id. **Change session** reopens the list.
- **Click a log entry** to send it to the agent as a `claude-log` note. The poll's `next_step` tells the agent to append the entry (session id, line `uuid`, part, role, kind, time, text) plus a `reported_at` time to the JSON array in `~/claude-errors/error-log.json`. A sent entry is marked, and clicking it again sends nothing. Select text inside an entry to copy it without sending.
- **Claude log page** (`/claude`, opened by bare `see-plan` in a terminal or by `see-plan logs`): the newest Claude session's id and last-prompt date on top, its log below, and a **Recent sessions** menu for the other 19. The log loads at least 200 entries when the session has that many (reading up to 16 MB back), then updates live. Add `?id=<uuid>` to the URL to open a given session. No agent is involved here: clicking an entry makes the server append it (session id, line `uuid`, part, role, kind, time, text, `reported_at`) to `~/claude-errors/error-log.json` itself. It creates the file if missing, keeps the records already there, skips an entry that is already logged, and refuses to touch a file that is not a JSON array.
- Every local process is trusted: the server has no token, so any process on this machine can attach a session id or trigger a launch. Do not run it on a shared machine.

## Environment variables

None are required; the defaults work out of the box. Set them only to change the behavior below.

| Variable | Default | Meaning |
| --- | --- | --- |
| `MY_LAVISH_PORT` | `4388` | Server port |
| `MY_LAVISH_STATE_DIR` | `~/.my-lavish-axi` | Holds `state.json` and `server.log` |
| `MY_LAVISH_NO_OPEN` | unset | `1` = never launch a browser (same as `--no-open`) |
| `MY_LAVISH_IDLE_TIMEOUT_MS` | `1800000` | Server exits after this long with no WebSocket or poll connections; `0` or `off` disables |

Example (PowerShell): `$env:MY_LAVISH_PORT = "5000"; see-plan examples/plan.html`
Example (bash): `MY_LAVISH_PORT=5000 see-plan examples/plan.html`

## Differences from lavish-axi

Left out on purpose, to keep only the core loop:

- Tailscale / phone access
- Excalidraw and Mermaid whiteboards
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
