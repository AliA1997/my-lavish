# my-lavish-axi — Design Spec

Date: 2026-10-24
Reference app: https://github.com/kunchenguid/lavish-axi (studied at commit `6c4f682`, v0.1.92)

## 1. What lavish-axi is

An **AXI**: a CLI meant to be run by an AI agent, not a person. The agent writes an HTML
artifact (a plan, diagram, table...) and runs `lavish-axi <file.html>`. A local browser page opens
showing the artifact. The human clicks elements or selects text to leave notes, types chat
messages, and presses **Send to Agent**. Meanwhile the agent is blocked in
`lavish-axi poll <file.html>`, a long-poll that returns the human's notes as structured data.
The agent edits the HTML, the page live-reloads, the agent posts a reply with
`poll --agent-reply "..."`, and the loop repeats until someone ends the session.

## 2. Evidence: how it works (source citations from the reference repo)

| Mechanism | Evidence |
| --- | --- |
| CLI spawns one **detached background server**, reused by later calls via `/health` | `src/cli.js:2240` `startServer` → `spawn(process.execPath, …)` with `detached: true` (`src/cli.js:2278`); `ensureServer` at `src/cli.js:1938` |
| **Session identity = file path**: key is the first 16 hex chars of sha256 of the realpath, so no opaque IDs | `src/session-store.js:826-827` `crypto.createHash("sha256").update(file).digest("hex").slice(0, 16)`; `canonicalFile` runs `realpath` (AGENTS.md) |
| `open` command: validate file → canonicalize → ensure server → `POST /api/sessions` → open browser → print `next_step` telling the agent to poll | `src/cli.js:373-410` `openCommand`; next_step text at `src/cli.js:357` ("Do not respond to the user just yet. Now you must run `lavish-axi poll …`") |
| Chrome page holds the artifact in a **sandboxed iframe without `allow-same-origin`** | `src/server.js:3114` `<iframe id="artifact" sandbox="allow-scripts allow-forms allow-popups …" data-artifact-src="/artifact/${key}/index.html">` |
| Artifact bytes are served **unchanged except one injected `<script>`** before `</body>` | `src/html-transform.js:1-12` `injectLavishSdk`; route `src/server.js:1555-1592` |
| The injected SDK turns clicks into prompts and **postMessages them to the parent chrome** | `src/artifact-sdk.js:472` `postArtifactMessage` → `parent.postMessage(...)`; `src/artifact-sdk.js:1218-1248` `queuePrompt` builds `{selector, tag, text, prompt}` |
| Chrome accepts messages only from its own iframe, queues them in `sessionStorage`, then `POST /api/:key/prompts` | `src/chrome-client.js:4257` `lavish:queuePrompt` → `enqueuePrompt`; storage at `:464-480`; POST at `:2119` |
| `/api/:key/prompts` is **same-origin guarded** — knowing the key is not authorization | docs/invariants.md "Request flow" step 6; AGENTS.md safety list |
| `poll` = **long-poll over an EventEmitter**; queued feedback returns immediately, otherwise waits for `feedback`/`ended` events | `src/server.js:1095-1137` (`events.on("feedback", …)`, `app.get("/api/poll", handlePoll)`) |
| `takeFeedback` **drains** the queue atomically under a lock; restored if the poll's client disconnected | `src/session-store.js:620-690`; restore rule in docs/invariants.md step 7 |
| Poll output puts `prompts` and `next_step` **before** the big `dom_snapshot`, so a truncating agent still sees the instructions | `src/cli.js:592-630` `createPollOutput` |
| Exactly **one poll listener** per session (`LISTENER_ACTIVE` / `--takeover`) | docs/invariants.md step 7, `activePolls` |
| Live events (chat sync, presence, reload) go over a **WebSocket** `/events/:key` with heartbeat | `src/chrome-client.js:4632` `new WebSocket(... "/events/" + key)` |
| Agent guidance is **served by the CLI** (`--help`, `design`, `playbook <id>`) and the skill is a stub that points there | `skills/lavish/SKILL.md`; playbook ids in `src/playbooks.js:9-345` (diagram, table, comparison, plan, code, input, explanation, slides) |
| Agent replies render a **small Markdown subset**; user text is **always escaped** | AGENTS.md: "Only agent chat entries render as HTML. User entries are always escaped." |
| State lives in `~/.lavish-axi/state.json`, overridable by env | README "Local-first state" |

Size of the reference: ~26k lines of `src`, 1,515 `node:test` tests. Most of that is hardening
and extras (Tailscale binding, Excalidraw whiteboards, layout audit, image attachments, ht-ml.app
sharing, telemetry, plugin setup). **my-lavish-axi copies the core loop only.**

## 3. Scope of my-lavish-axi (MVP)

In scope:

1. CLI `my-lavish-axi` with commands: (home), `<file>`/`open <file>`, `poll <file>`, `reply <file>`,
   `end <file>`, `stop`, `design`, `playbook [id]`, `server`.
2. Detached local server reused across CLI calls.
3. Sessions keyed by sha256(realpath) prefix, persisted in `state.json`.
4. Chrome page: sandboxed artifact iframe + Conversation panel (chat transcript, queued notes,
   composer, **Send to Agent**, **Send & End**, agent-presence banner).
5. Injected SDK: annotate mode (hover outline, click element → note card), text-selection notes,
   `window.lavish.queuePrompt()` API, Ctrl/Cmd+I toggles annotate/explore, ignores native controls
   and `[data-lavish-action]`, answers DOM-snapshot requests.
6. Long-poll feedback delivery, single listener, restore-on-disconnect, agent replies, end session
   with `ended_by` (user ended → plain reopen refused unless `--reopen`).
7. Live reload when the HTML file changes (chokidar), scroll position kept.
8. TOON output (compact agent-friendly text) with `--json` fallback; every output has `next_step`.
9. Security basics: Host allowlist (loopback names), same-origin guard on mutating browser routes,
   asset confinement to the artifact's directory, `X-Frame-Options: DENY` on the chrome page,
   escaped user text.
10. Built-in guidance: `design` text and five playbooks (`plan`, `diagram`, `table`, `comparison`, `input`).
11. Skill stub `skills/my-lavish/SKILL.md`.

Out of scope: Tailscale/phone access, Excalidraw/Mermaid whiteboards, layout-issue audit,
image attachments, export/share, telemetry, plugin/hook setup, self-update, revisions legend.

## 4. Configuration

| Env var | Default | Meaning |
| --- | --- | --- |
| `MY_LAVISH_PORT` | `4388` | Server port (4387 is the reference app's default, avoid clashing) |
| `MY_LAVISH_STATE_DIR` | `~/.my-lavish-axi` | `state.json` + `server.log` |
| `MY_LAVISH_NO_OPEN` | unset | `1` = never launch a browser (same as `--no-open`) |
| `MY_LAVISH_IDLE_TIMEOUT_MS` | `1800000` | Server exits after this long with no WebSocket or poll connections; `0`/`off` disables |
