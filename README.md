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
| `see-plan` | Lists known sessions and usage |
| `see-plan <file.html|file.md>` / `open <file>` | A `.md` plan is converted to a sibling `.html` (regenerated when the `.md` is newer, never over a hand-written `.html`); agents edit the `.md`. Opens (or reopens) the session and the browser. A session the user ended is refused unless `--reopen` is given |
| `poll <file>` | Blocks until the user sends feedback or ends the session; prints prompts, `next_step`, and a DOM snapshot |
| `poll <file> --agent-reply "<text>"` | Posts a reply to the chat, then polls |
| `reply <file> --agent-reply "<text>"` | Posts a reply without polling |
| `end <file>` | Ends the session |
| `stop` | Stops the background server |
| `design` | Prints the design rules for artifacts |
| `playbook [id]` | Lists playbooks, or prints one (`plan`, `diagram`, `table`, `comparison`, `input`) |
| `server` | Runs the server in the foreground (normally started automatically) |

Flags: `--json` (JSON instead of TOON text), `--no-open` (do not launch a browser), `--reopen`, `--agent-reply <text>`, `--agent-reply-file <path|->`, `--timeout-ms <n>` (poll returns `waiting` after this long), `--help`, `--version`.

Every output includes a `next_step` telling the agent what to do next.

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
