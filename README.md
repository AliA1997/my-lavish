# my-lavish-axi

A CLI built for AI agents. The agent writes an HTML artifact (a plan, diagram, table, report) and runs `my-lavish-axi <file.html>`. A local browser page opens; the human clicks elements or selects text to leave notes, chats, and presses **Send to Agent**. Meanwhile the agent waits in `my-lavish-axi poll <file.html>`, which returns the feedback as structured data.

This is a small re-implementation of the core loop of [lavish-axi](https://github.com/kunchenguid/lavish-axi).

## Quick start

```
npm install
npm link
my-lavish-axi examples/plan.html
```

Then, in another terminal (or as the agent):

```
my-lavish-axi poll examples/plan.html
```

Requires Node 22 or newer.

## How it works

```
 agent writes HTML
        |
        v
 my-lavish-axi <file>  --->  detached local server + browser page opens
        |                                   |
        v                                   v
 my-lavish-axi poll <file>          human annotates, chats,
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
| `my-lavish-axi` | Lists known sessions and usage |
| `my-lavish-axi <file.html>` / `open <file>` | Opens (or reopens) the session and the browser. A session the user ended is refused unless `--reopen` is given |
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

| Variable | Default | Meaning |
| --- | --- | --- |
| `MY_LAVISH_PORT` | `4388` | Server port |
| `MY_LAVISH_STATE_DIR` | `~/.my-lavish-axi` | Holds `state.json` and `server.log` |
| `MY_LAVISH_NO_OPEN` | unset | `1` = never launch a browser (same as `--no-open`) |
| `MY_LAVISH_IDLE_TIMEOUT_MS` | `1800000` | Server exits after this long with no WebSocket or poll connections; `0` or `off` disables |

## Smoke test

`npm run smoke` runs the whole loop against a throwaway server and prints `SMOKE OK`. Unit tests: `npm test`.

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
