# see-plan: Fixes, Four-Stage Workflow, and GitHub Release — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the problems found in the 2026-11-01 review. Make **Connect Claude** reliable from the page, and keep it connected: the agent quietly re-polls every **1 min 50 s** in the background, and the user keeps seeing "connected" the whole time. Add feedback on whole sessions and whole plans. Run every feature through four stages, each with its own Claude session: **Plan → Interrogation → Implementation → Verification**. Ship a standalone `see-plan` executable as a GitHub Release, under a clear license.

**Architecture:** This builds on the pieces already there: `src/cli.js` (commands), `src/server.js` (Express + WebSocket), `src/session-store.js` (state.json), `src/chrome-page.js` + `public/chrome-client.js` (side panel), `src/claude-launcher.js`, `src/claude-log.js`. New modules:
- `src/stages.js`: stage names, label inference, and the per-stage prompt and next-step text.
- `src/workflow-store.js`: groups four sessions into one feature. It is kept inside state.json.
- `src/feedback-log.js`: session and plan feedback records. It generalizes `src/error-log.js`.
- `src/assets.js`: reads `public/*` from disk, or from SEA assets when packaged.
- `src/open-url.js`: replaces the `open` dependency.
- `src/home-page.js` + `public/home-client.js`: the dashboard at `/`.

**Tech Stack:** Node 22+ ESM, Express 5, ws, chokidar, marked, `node --test`. Release builds add the dev-only tools `esbuild` (bundle to one CJS file) and `postject` (inject the Node SEA blob). The release runs on GitHub Actions.

**Spec (the user's request, cleaned up; truncated lines are completed in [brackets]):**
> - Find issues with the project; afterwards generate a plan for fixing those issues.
> - Make sure the user can connect to their Claude agent from the UI.
> - Session management, such as sending feedback regarding a session.
> - Plan management, such as sending feedback regarding a plan.
> - Follow proper User Experience practices; the UI is easy to use.
> - Follow proper Agent Experience (AX) practices.
> - The agent follows these steps for a feature, opening 4 sessions sequentially: Plan session (create a plan from requirements) → Interrogation (update the plan by grilling the agent about it) → Implementation (agent implements) → [Verification (agent] verifies it).
> - Handle proper labeling if the user mentions it's a plan/interrogation/[implementation/verification].
> - At the end, create an executable installed from GitHub: the Release.
> - Make any licensing change to the repository if necessary to ensure that the rel[ease can be distributed].
> - *(Added 2026-11-01)* Keep the user connected at all times. Every 1 minute and 50 seconds, poll to reconnect to Claude behind the scenes. To the user, it still looks connected.

---

## Part 1: Issues found

Each issue has an ID that the tasks below refer to. Severity: **H** breaks a core flow, **M** hurts UX/AX or correctness, **L** is polish.

### Connecting Claude from the UI

| ID | Sev | Issue | Where |
| --- | --- | --- | --- |
| C1 | H | **Claude Code's Bash tool kills the blocking poll after 2 min.** The default is 120 s and the maximum is 10 min. `see-plan poll` has no default timeout, and its `next_step` says "leave it running". The agent sees a timeout error, and nothing tells it to poll again. | `src/cli.js:56` (`createOpenOutput`), `cmdPoll` |
| C2 | H | **The page offers to start a second Claude while one is alive.** Every time a poll ends (killed by C1, or returning `waiting`), presence becomes "not listening" and the **Connect Claude** banner comes back. The 60 s cooldown covers only the first minute after a launch, so a click starts a second Claude window. | `src/server.js:629-641`, `public/chrome-client.js:213` |
| C3 | H | **"Claude is starting…" never ends.** `connecting` is reset only when a poll starts listening. If Claude stops at the folder-trust dialog, a login prompt, or a Bash permission prompt for `see-plan poll`, the hint stays forever, with no timeout and no help. | `public/chrome-client.js:237` |
| C4 | M | **Connect Claude only works on Windows, but the button shows everywhere.** On macOS/Linux, a click returns `501 UNSUPPORTED_PLATFORM` after the fact. The UI never asks the server whether a launch can work. | `src/claude-launcher.js:78` |
| C5 | M | **One launch blocks all sessions.** The launch cooldown is shared by the whole server, so a launch for plan A refuses plan B for 60 s with a misleading message. | `src/server.js:107,370` |
| C6 | M | **A previous Claude session cannot be resumed.** Connect always starts a new `--session-id`, even when the session already has a `claude_session_id` with a transcript. | `src/server.js:373` |
| C7 | M | **The launched Claude stops at a permission prompt** for `see-plan poll …`, and nothing tells the user how to allow it once. | launcher prompt, README |

### Session management

| ID | Sev | Issue | Where |
| --- | --- | --- | --- |
| S1 | H | **No way to give feedback about the session itself** (the agent's behavior, speed, mistakes). Feedback can only target the artifact or a single log line. | — |
| S2 | M | **One click on a log line sends it at once.** There is no note, no confirmation, and no undo, and every click means "add to error log". Accidental clicks are common when reading. | `public/chrome-client.js:611-621` |
| S3 | M | **The two log views behave differently.** In the panel, the *agent* is told to write `~/claude-errors/error-log.json`, which spends tokens and can fail. On `/claude`, the *server* writes it. The server should always write it. | `src/cli.js:81`, `src/server.js:500` |
| S4 | M | **Start new session deletes the chat for good.** No history of earlier rounds is kept. | `src/session-store.js:209` |
| S5 | M | **`http://127.0.0.1:4388/` returns "Cannot GET /".** No page lists sessions or features. They can only be seen from the CLI. | `src/server.js` (no `/` route) |
| S6 | L | **state.json grows forever.** Sessions for deleted files never go away, and nothing archives or deletes them. | `src/session-store.js` |
| S7 | L | **Running bare `see-plan` in a terminal opens a browser.** That is a surprising side effect for "show me usage". | `src/cli.js:501` |

### Plan management

| ID | Sev | Issue | Where |
| --- | --- | --- | --- |
| P1 | H | **No explicit Approve / Request changes decision on a plan.** Approval is only implied through chat, so the workflow cannot advance a stage. | — |
| P2 | M | **No revision history and no "what changed".** The page reloads in place, and the human cannot see what the agent edited between rounds. | `src/server.js:178-185` |
| P3 | M | **Unsent notes are lost when the tab closes**, because the queue is kept in `sessionStorage`. | `public/chrome-client.js:93` |
| P4 | L | **Editing the `.md` does not refresh the page.** Only the generated `.html` is watched, so the change shows up only at the next `poll` or `open`. | `src/server.js:174` |
| P5 | L | **No general comment on the whole plan.** Notes always attach to an element, a text selection, or chat. | — |

### UX

| ID | Sev | Issue | Where |
| --- | --- | --- | --- |
| U1 | M | **Attaching a Claude session switches the panel to the Claude log tab, which hides the chat *and the queued notes*.** The user annotates and sees nothing queued. | `public/chrome-client.js:182,848` |
| U2 | M | **Destructive buttons sit next to Send.** **Send & End** and **End session** are beside **Send**, with no confirmation and no undo. | `src/chrome-page.js` composer |
| U3 | M | **No first-run guidance.** The empty chat does not say "click any part of the plan to leave a note", and the Ctrl+I annotate toggle cannot be discovered. | `public/chrome-client.js` |
| U4 | M | **The connection state is spread over three widgets** (status line, presence banner, send hint), and the wording does not match. | `src/chrome-page.js:47-49` |
| U5 | L | **The ended state only offers Start new session.** The CLI's `--reopen` (resume with history) has no button. | `public/chrome-client.js:251` |
| U6 | L | **Tabs miss parts of the ARIA tab pattern** (`aria-controls`, arrow-key navigation). Log rows read their whole text as the button name. | `src/chrome-page.js:51` |

### Agent experience (AX)

| ID | Sev | Issue | Where |
| --- | --- | --- | --- |
| A1 | H | Same as C1: no safe default for agents that run under a command timeout. | `src/cli.js` |
| A2 | M | **No read-only `status` command.** The only way to learn a session's state is a poll, which takes the feedback. | `src/cli.js` |
| A3 | M | **The agent cannot say which stage it is working on**, and outputs carry no stage, so `next_step` text is the same for planning, implementing, and verifying. | — |
| A4 | M | **The skill is two lines.** It says nothing about stages, timeouts, background polling, or permissions. | `skills/my-lavish/SKILL.md` |
| A5 | L | **`HOME_USAGE` leaves out `--claude-session`, `--with-claude`, and `--timeout-ms` on its flags line.** The open output asks for a session id that poll already detects. | `src/guidance.js:84`, `src/cli.js:68` |

### Repository, licensing, release

| ID | Sev | Issue | Where |
| --- | --- | --- | --- |
| R1 | H | **No LICENSE file**, and `package.json` has no `license` field. The GitHub repo is public with `license: null`, which legally means "all rights reserved", so a release cannot be redistributed. | repo root |
| R2 | M | **The project re-implements kunchenguid/lavish-axi (MIT, © 2026 Kun Chen)** and reuses its public API names (`window.lavish`, `data-lavish-*`), but there is no NOTICE crediting it. | README |
| R3 | H | **The code cannot run as a single executable.** It spawns `process.execPath bin/see-plan.js server` (`src/cli.js:227`), reads `package.json` at runtime (`:18`), serves `public/` from disk (`src/server.js:21,755`), and the `open` package looks for its own `xdg-open` file next to its module. All four break inside a Node SEA. | as listed |
| R4 | M | **No CI and no release workflow**, and no `files` field in `package.json`, so `npm pack` would ship tests and evidence PNGs. | repo root |
| R5 | M | **About 1,300 lines of work are uncommitted** (staged + unstaged + untracked: logs page, error log). The last commit is called "Added changes." | git status |

---

## Decisions made for you (review these)

1. **Stages are a property of a session; a *feature* (workflow) groups four sessions.** Sessions are still keyed by file path, so nothing that exists today breaks. A session's `stage` is one of `plan | interrogation | implementation | verification`, or `null` (a plain review, as today).
2. **Each stage gets its own fresh Claude session.** The user asked for four sessions, and fresh context keeps each stage honest: the verifier did not write the code. The page launches each one with a stage-specific prompt. A stage starts only when the previous stage is **Approved**, or when the user presses **Skip to next stage**.
3. **The artifact for each stage:**

   | Stage | Artifact the human reviews | The Claude session's job | Done when |
   | --- | --- | --- | --- |
   | Plan | `<feature>.plan.md` (rendered) | Write the plan from the requirements file/text | The human presses **Approve plan** |
   | Interrogation | `<feature>.interrogation.html` (input playbook: numbered questions, each with a recommended answer) | Grill the plan, gather the human's answers, then update `<feature>.plan.md` | The human approves the updated plan |
   | Implementation | `<feature>.progress.html` (the plan's tasks with live status and the Claude log) | Implement the plan task by task, and update progress after each task | The agent reports done and the human approves |
   | Verification | `<feature>.verification.html` (acceptance criteria → pass/fail with evidence, test output) | Run tests, check each requirement, and record evidence | The human presses **Accept**, or sends issues back to Implementation |

   A rejected Verification reopens Implementation with the issues queued as feedback, so the loop can repeat.
4. **Labeling priority** (highest first): explicit `--stage` flag → a stage the human picks in the panel's stage dropdown → the user's own words in a chat message (`"this is the interrogation"`, `"let's verify"`) → the file name (`*.plan.md`, `*interrogation*`, `*verification*`/`*verify*`, `*progress*`/`*implementation*`) → the workflow's current stage. An inferred label (from words or file name) shows as **"Interrogation? (inferred)"** with a one-click **Confirm** / **Change** control. The agent never silently re-labels a stage the human set.
5. **Claude sessions are labeled too.** The launch prompt starts with `[see-plan · <feature> · <Stage>]`. `listClaudeSessions` titles sessions by their first prompt, so the "Recent sessions" list then reads e.g. `[see-plan · auth-refresh · Interrogation] …`.
6. **A silent 1 min 50 s reconnect cycle keeps the agent connected** (fixes C1, C2, A1, and the "stay connected" request):
   - **Cycle length: 110 000 ms (1:50).** This is under Claude Code's *default* Bash timeout of 120 s, so the poll ends cleanly on its own before the Bash tool would kill it. The agent does not need to pass a `timeout` to its Bash tool or run the poll in the background.
   - **Two layers enforce it.** The CLI defaults `--timeout-ms 110000` when `CLAUDECODE=1` (or `--agent`). The server also caps every agent poll (`agent: true`) at `agentPollMs` = 110 000, so an older CLI or a poll without the flag still cycles. Humans running `see-plan poll` by hand keep today's behavior (no timeout), unless they pass one.
   - **On timeout** the poll returns `status: "waiting"` with `reconnect: true` and a short `next_step`: *"Routine reconnect. Run `<same command>` again now. Do not reply to the user."* The agent re-polls at once, so the gap is usually under 1 s.
   - **The user sees "connected" the whole time.** The server gives each session a **20 s grace period** after a listening poll ends. During the grace period, presence still reports `listening: true` (with an internal `cycling: true` the UI ignores). The status card, the Connect banner, and the send hint do not change, and nothing flashes. Only when the grace period runs out with no new poll does presence switch to "not connected".
   - **No feedback is lost in the gap.** Notes sent during the grace period are queued as usual and handed to the very next poll. The send hint says "Sent", not "Waiting for agent".
   - Presence also records `last_poll_at`. The status card shows it only in a tooltip ("Last check-in 0:42 ago"), for debugging, never as a visible state change.
7. **The server always writes the error log and the feedback log itself.** The agent receives the record as information and is never asked to do file I/O (fixes S3).
8. **Connect Claude on macOS/Linux:** macOS opens Terminal via `osascript`. Linux tries `x-terminal-emulator`, `gnome-terminal`, `konsole`, and `xterm` in that order. If none is found, the UI shows a **Copy command** box with the exact command to paste. Windows keeps the hardened PowerShell launch.
9. **License: MIT** for this repo, `Copyright (c) 2026 AliA1997` (change the holder to your legal name if you prefer). A `NOTICE` file credits lavish-axi. Release archives also carry `THIRD_PARTY_LICENSES.txt`, with every bundled dependency (all MIT/ISC/BSD-3-Clause, checked) **plus Node.js's own license**, because a SEA binary contains the Node runtime.
10. **Executable = Node Single Executable Application (SEA)**, bundled to one CJS file with esbuild so we do not depend on SEA's ESM support. Targets: `win-x64` (primary, since Connect Claude was built for Windows first), `linux-x64`, `macos-arm64`, `macos-x64`. The Windows build is unsigned at first (SmartScreen will warn; this is documented). Ad-hoc `codesign -s -` on macOS.
11. **Distribution:** a GitHub Release on tag `v*` with per-platform archives, `SHA256SUMS`, and `install.ps1` / `install.sh` one-liners that download the latest release into `~/.see-plan/bin` and add it to the user's PATH. `npm install -g github:AliA1997/my-lavish` keeps working as the Node-based path.

## Global Constraints

- Node `>=22` for the npm path. SEA builds use Node 22 LTS on CI (pinned version) so the embedded runtime is predictable.
- ESM in `src/`. The SEA bundle is CJS, produced by esbuild. No runtime dependency is added; `open` is **removed**.
- `/health` keeps `app: "my-lavish-axi"`. The `MY_LAVISH_*` env vars and the `~/.my-lavish-axi` state dir are unchanged.
- state.json changes are **additive** (`stage`, `stage_label_source`, `workflow_id`, `history`, `feedback`), and old files load unchanged. Bump `version` to 2 only if a field changes meaning.
- Every new browser-callable write endpoint requires `requireSameOrigin(req)`. CLI-callable ones require `Content-Type: application/json`. Same rules as before.
- `public/*.js` stay ES5-style IIFEs (`var`, `function`), like the files they extend.
- Every agent-facing output keeps a `next_step`. New fields go into the existing `session` object, never into new top-level shapes that agents must learn.
- Run `npm test` and `npm run smoke` green before each commit. Release tasks also need `npm run build:sea` and a smoke test of the built binary.
- Never pass a permission-bypass flag to `claude`.

## Review Focus

1. **Silent reconnect (C2):** an agent poll ends at 1:50 even without `--timeout-ms` (server cap). A poll that ends and comes back within 20 s must never change what the user sees: no Connect banner, no "reconnecting" text, no `listening:false` broadcast. A Connect click during the gap must be refused with `AGENT_RECONNECTING`. A note sent during the gap reaches the next poll. Pinned in Tasks 1–2.
2. **Stuck launch (C3):** after 45 s without a poll, the UI must leave "starting" and show recovery steps. Pinned in Task 3.
3. **Label precedence:** an inferred label must never overwrite one the human set. Pinned in Task 9 (`human label wins over inference`).
4. **Stage gating:** a Connect Claude launch for stage N+1 is refused until stage N is approved or skipped. Pinned in Task 10.
5. **SEA packaging:** the built binary must start its own background server (`execPath server`, with no script path) and serve every `public/` asset. Pinned in Task 14 by a smoke test of the binary.
6. **Feedback never lost:** session feedback and plan decisions queued while no agent polls must reach the next poll and survive a server restart. Pinned in Tasks 5–6.

## Performance

- **Expected load:** one person, up to ~4 sessions per feature, a few features. No change to the log-reading budgets (256 KB per panel read, 16 MB maximum for the page).
- **Revision history (P2):** store at most the last 20 revisions per session, as the artifact HTML (or `.md` source) under `<stateDir>/revisions/<key>/<n>.html`. Never put them in state.json, which is read on every request. Compute the diff in the browser only when it is asked for.
- **Presence grace:** one timer per session key, cleared when a poll starts listening. No polling loops.
- **Reconnect cycle cost:** one poll every 110 s is about 33 short HTTP requests per hour per connected agent, plus one Bash tool call each in the agent's transcript. That is negligible for the server. Keep the `waiting` output under ~300 bytes so the agent's context grows slowly over long waits.
- **Home dashboard:** one `listSessions()` call per load. Updates arrive over a server-wide WebSocket channel `/events/home`, with no HTTP polling.

## Security

- **Launch on macOS/Linux** follows the Windows rule: no path or prompt text is spliced into a shell string. Pass them as argv or env (`osascript -e` with `quoted form of (system attribute "SEE_PLAN_PROMPT")`, and argv arrays for terminal emulators). Test with the hostile path from the earlier plan: `O'Brien\x’; calc; ’\$(calc)`.
- **`--resume <id>`** only takes ids that pass `isClaudeSessionId`.
- **Feedback text is untrusted.** It is rendered with `textContent` only, and the agent gets it as data inside `prompts[]`, never spliced into `next_step`.
- **install.ps1 / install.sh** download only from `https://github.com/AliA1997/my-lavish/releases/` and check the file against `SHA256SUMS` before installing.
- **Release workflow** gets only `contents: write`, pins its actions by commit SHA, and never runs on `pull_request` from forks.

---

## Part 2: Tasks

### Task 0: Commit the work in progress (R5)

**Files:** none new.

- [ ] **Step 1:** `git switch -c chore/logs-page-wip`, run `npm test && npm run smoke`, and commit the staged, unstaged, and untracked logs-page / error-log work in logical commits (`feat: claude log page`, `feat: server-side error log`). The plan file `2026-10-24-see-plan-updates.html` is generated; ignore it (add `docs/**/*.html` with a matching generator meta to `.gitignore`, or commit it on purpose).
- [ ] **Step 2:** Merge to `main` (or open a PR) before Task 1, so later diffs stay reviewable.

---

### Task 1: The 1 min 50 s reconnect cycle (C1, A1, A5, "stay connected")

**Files:** `src/cli.js`, `src/server.js`, `src/guidance.js`, `test/cli.test.js`, `test/server-loop.test.js`, `README.md`

- [ ] **Step 1: Failing tests** in `test/cli.test.js`:
  - `poll defaults to 110000 ms under Claude Code`: with `env.CLAUDECODE="1"` and no `--timeout-ms`, the request body has `timeoutMs: 110000`. Without `CLAUDECODE` or `--agent`, there is no timeout (humans keep today's behavior).
  - `explicit --timeout-ms wins`: `--timeout-ms 30000` sends 30000. `--timeout-ms 0` under an agent is raised to the server cap, not unlimited (see the server test).
  - `waiting next_step is a routine reconnect`: on `reconnect: true` the text contains the exact poll command, the words "run it again now", and "do not reply to the user". It is under 300 bytes. It no longer tells the agent to drop `--timeout-ms`.
  - `open next_step explains the cycle`: it says the poll returns about every 1:50 and must be run again each time. It no longer asks for `--claude-session` when `CLAUDE_CODE_SESSION_ID` is set.
  - `HOME_USAGE lists every flag`: every entry in `VALUE_FLAGS ∪ BOOL_FLAGS` (except `-h`) appears in `HOME_USAGE`.
- [ ] **Step 2: Failing tests** in `test/server-loop.test.js` (pass a short `agentPollMs` to `createServer` for speed):
  - `agent polls are capped at agentPollMs`: an `agent: true` poll with no `timeoutMs` (or a larger one) returns `{ status: "waiting", reconnect: true }` after `agentPollMs`.
  - `non-agent polls are not capped`: a poll without `agent` still waits until feedback or its own timeout.
- [ ] **Step 3: Run** `node --test test/cli.test.js test/server-loop.test.js`. Expected: FAIL.
- [ ] **Step 4: Implement.**
  - CLI: add `const AGENT_POLL_MS = 110000`, applied in `cmdPoll` when `pollingAgent(...).agent` is set and no flag was given. Add an `--agent` boolean flag that opts in outside Claude Code (for other agents).
  - Server: `createServer({ agentPollMs = 110000 })`. In `handlePoll`, when `agent` is true, use `min(timeoutMs || Infinity, agentPollMs)`. The timeout reply carries `reconnect: true`.
  - Rewrite the `waiting` step: *"Routine reconnect (every 1:50, so your Bash timeout never kills the poll). Run `<same command>` again now. Do not reply to the user."*
  - README: one paragraph explaining the cycle and that the panel stays "connected" through it.
- [ ] **Step 5: Run** `npm test && npm run smoke`. Expected: PASS.
- [ ] **Step 6: Commit**: `fix: agents re-poll every 1:50 so the connection never times out`

---

### Task 2: Invisible reconnects and no duplicate launches (C2, C5, "stay connected")

**Files:** `src/server.js`, `test/server-loop.test.js`, `public/chrome-client.js`, `test/public-assets.test.js`

- [ ] **Step 1: Failing tests** (`test/server-loop.test.js`, using short `presenceGraceMs` and `agentPollMs` passed to `createServer` for speed):
  - `a reconnect cycle is invisible`: run three agent polls back to back, each ending by the `agentPollMs` cap. Collect WebSocket messages. Every `presence` message has `listening: true`; none has `listening: false`.
  - `after the grace period presence says not listening`: end a poll and do not re-poll; after `presenceGraceMs`, one `presence` with `listening: false` arrives.
  - `a note sent during the gap reaches the next poll`: end a poll, `POST /api/:key/prompts` during the grace period, re-poll. The poll returns the note at once. The `/prompts` reply says `delivered: "queued-for-agent"` (the send hint shows "Sent").
  - `connect-claude during the grace period is 409 AGENT_RECONNECTING`.
  - `launch cooldown is per session`: a launch for key A does not refuse key B.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - In `poll.release()`, if the poll was listening, set `agents.get(key).graceUntil = now + presenceGraceMs` (default 20000) and start one timer per key. **Do not broadcast** at this point. `presence(key)` reports `listening: true, cycling: true` while `now < graceUntil`. When the timer fires and no poll is listening, broadcast `listening: false`.
  - A new listening poll clears the timer and `graceUntil`. It broadcasts only if the visible state changed (it did not, during a cycle).
  - Add `last_poll_at` to presence.
  - Replace `pendingLaunch` with `Map<key, at>`.
  - Client: treat `cycling` exactly like connected. It never shows "reconnecting" text and keeps the Connect banner hidden.
- [ ] **Step 4: Run** `npm test && npm run smoke`. Expected: PASS. Manually: connect a real Claude and leave the page open for 10 minutes (about five cycles). The card stays "● Claude connected" the whole time, and a note sent at minute 7 is answered.
- [ ] **Step 5: Commit**: `fix: reconnect cycles are invisible to the user; per-session launch cooldown`

---

### Task 3: A Connect Claude state machine that recovers (C3, C4, C6, C7, U4)

**Files:** `src/claude-launcher.js`, `src/server.js`, `src/chrome-page.js`, `public/chrome-client.js`, `public/chrome.css`, `test/claude-launcher.test.js`, `test/server-loop.test.js`, `test/public-assets.test.js`

- [ ] **Step 1: Failing tests:**
  - `GET /api/claude-status` returns `{ platform, launch: "powershell"|"osascript"|"terminal"|"copy", claude_found, claude_path }`. `findClaude` is injected.
  - `buildClaudeLaunch` for `darwin` passes the prompt via env and never puts the file path in the `osascript` script text (hostile path test).
  - Linux: the first available emulator is chosen from an injected `which`. If none is found, `launch: "copy"` and `connect-claude` returns `{ ok:true, mode:"copy", command }` without spawning.
  - `connect-claude {resume:true}` with an existing transcript starts `claude --resume <id>`, never with an unvalidated id.
  - `the launch prompt starts with the [see-plan · …] label and explains the 1:50 reconnect cycle` (poll returns `waiting` with `reconnect: true` → run it again right away, silently).
  - Client (`public-assets.test.js` static checks): one `#connection` region with `data-state` ∈ `idle|starting|connected|working|stuck|unsupported`. There is no user-visible `reconnecting` state: a reconnect cycle stays `connected`. The old `#presenceBanner` and `#agentStatus` are merged into it.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Server: `/api/claude-status` (same cross-site guard as the other GETs). Cache `findClaude` per process.
  - Launcher: `launchClaude({ platform })` dispatches to `win32` (today's code), `darwin`, or `linux`. Each returns `{ mode, command? }`.
  - **One connection card** at the top of the panel replaces the status line, the banner, and the hint:

    | State | Text | Actions |
    | --- | --- | --- |
    | idle | "No agent connected." | **Connect Claude** (primary) · **Resume last session** (if a transcript exists) · *How do I connect manually?* (shows the poll command, with copy) |
    | starting | "Starting Claude… 0:12" (live timer) | **Cancel** (clears the per-key cooldown) |
    | stuck (45 s and no poll) | "Claude hasn't started polling. Check the Claude window: it may be asking to trust this folder, to log in, or to allow `see-plan`." | **Copy allow-rule** (`"Bash(see-plan:*)"` for `.claude/settings.json`) · **Try again** · **Copy command** |
    | connected (also during a 1:50 reconnect cycle) | "● Claude connected — waiting for your feedback · session 1a2b3c4d" (tooltip: "Last check-in 0:42 ago") | **View log** |
    | working | "● Claude is working on your feedback" | **View log** |
    | unsupported / copy | "Can't open a terminal here. Run this in your terminal:" + command | **Copy** |
- [ ] **Step 4: Run** `npm test && npm run smoke`. Manually on Windows: Connect → card goes starting → connected. Wait through two reconnect cycles (about 4 min) → the card never leaves connected. Kill the Claude window → the card stays connected for up to the 20 s grace period, then goes idle. Repeat with a folder Claude has never trusted → stuck after 45 s, with instructions.
- [ ] **Step 5: Commit**: `feat: reliable Connect Claude with status card, resume, and macOS/Linux launch`

---

### Task 4: Panel UX fixes (U1, U2, U3, U5, U6, P3, S7)

**Files:** `src/chrome-page.js`, `public/chrome-client.js`, `public/chrome.css`, `src/cli.js`, tests

- [ ] **Step 1: Failing tests** (static and DOM-free checks in `public-assets.test.js`, CLI in `cli.test.js`):
  - Queued notes render **above the tabs**, so they show on both tabs. The page no longer auto-selects the log tab on load.
  - **End session** and **Send & End** sit in a `⋯ More` menu. Ending opens a confirm dialog (`<dialog>`) that shows the count of unsent notes.
  - The empty chat shows a first-run tip with the Ctrl+I shortcut.
  - The ended banner offers **Resume (keep history)** → `POST /api/:key/reopen` (same-origin), and **Start fresh**.
  - Tabs have `aria-controls`, roving `tabindex`, and Left/Right arrow handling.
  - The queue is saved in `localStorage` under the same key and is cleared when the server accepts it.
  - Bare `see-plan` in a TTY prints usage and the log page URL **without** opening a browser. `see-plan logs` still opens it.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** Composer layout: textarea on top; **Send to Agent** (primary, right-aligned) and **Annotate: on/off** on the bottom row; `⋯` for the destructive actions. Add `POST /api/:key/reopen` (reuses `reopen_`).
- [ ] **Step 4: Run** `npm test && npm run smoke`, then a manual browser pass (light and dark mode, 1280 px and 900 px wide).
- [ ] **Step 5: Commit**: `fix: panel layout, confirmations, first-run tip, persistent queue`

---

### Task 5: Session feedback (S1, S2, S3)

**Files:** new `src/feedback-log.js` (generalizes `src/error-log.js`), `src/server.js`, `src/cli.js`, `src/session-store.js`, `public/chrome-client.js`, `src/chrome-page.js`, `public/logs-client.js`, tests

- [ ] **Step 1: Failing tests:**
  - `POST /api/:key/session-feedback {rating: "up"|"down", categories: [...], text}` (same-origin). It queues a prompt with `tag: "session-feedback"` and `target: { rating, categories, claude_session_id, stage }`. It also appends a record to `<stateDir>/feedback.jsonl`. Invalid ratings or categories → 400.
  - A **log entry click opens a small popover** instead of sending: a note field plus **Send to agent** / **Log as error** / **Both**. *Log as error* makes the **server** append to `~/claude-errors/error-log.json` (shared code with `/api/claude-errors`). *Send to agent* queues a `claude-log` prompt with the note.
  - `poll next_step for claude-log prompts no longer asks the agent to write files`. It says the entries were already logged and asks the agent to address the user's note.
  - `poll next_step for session-feedback`: "The user rated this session 👎 (categories: …). Adjust how you work. Acknowledge in your reply."
  - Records survive a server restart (queued in state.json like other prompts).
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** Add a **Session feedback** button on the connection card (enabled whenever a session is open, connected or not). It opens a `<dialog>` with 👍/👎, category chips (*Wrong direction*, *Too slow*, *Broke something*, *Ignored my notes*, *Great job*), and a text field. Categories are a fixed list in `src/stages.js`.
- [ ] **Step 4: Run** `npm test && npm run smoke`.
- [ ] **Step 5: Commit**: `feat: session feedback and note-first log entry actions`

---

### Task 6: Plan decisions and plan-level comments (P1, P5)

**Files:** `src/server.js`, `src/session-store.js`, `src/cli.js`, `public/chrome-client.js`, `src/chrome-page.js`, tests

- [ ] **Step 1: Failing tests:**
  - `POST /api/:key/decision {decision: "approve"|"request-changes", comment}` (same-origin). It records `session.decision = { value, comment, at, revision }` and queues a `tag: "decision"` prompt. **Approve** sets `status: "approved"`, a new terminal state that ends polling like `ended`, but with `ended_by: "approved"`.
  - `approve on a session with unsent notes is refused unless force:true` (the UI asks first).
  - `poll output for approve`: `session.status = "approved"`, and `next_step` says to stop polling and, inside a workflow, to report done. The next stage is started by the human or the page, never by the agent on its own.
  - `poll output for request-changes` behaves like feedback, with the comment first.
  - A **plan-level comment** (`tag: "plan"`, anchor "Whole plan") can be queued from a "Comment on the whole plan" composer option.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** A decision bar above the composer, with **Approve** (green) and **Request changes**. It shows only when the session has a stage or a plan (`.md` source or `stage === "plan"`).
- [ ] **Step 4: Run** `npm test && npm run smoke`.
- [ ] **Step 5: Commit**: `feat: approve or request changes on a plan`

---

### Task 7: Revision history, "what changed", and `.md` watching (P2, P4, S4)

**Files:** `src/server.js`, `src/session-store.js`, new `src/revisions.js`, `public/chrome-client.js`, `public/sdk.js`, tests

- [ ] **Step 1: Failing tests:**
  - On each `bumpRevision`, the artifact source is copied to `<stateDir>/revisions/<key>/<n>.html` (and the `.md` too, when there is one). Only the last 20 are kept.
  - `GET /api/:key/revisions` → `[{ n, at, bytes }]`. `GET /api/:key/revisions/:n` → the source (cross-site guard).
  - The SDK gets `{type:"highlightChanges", added:[selectors]}` and outlines changed blocks for 10 s after a reload. The changed block selectors are computed by comparing the text of top-level blocks in the old and new DOM snapshots.
  - Watching a session with `source_file` also watches the `.md`. A change regenerates the HTML (`ensurePlanHtml`), which then triggers the normal reload.
  - `startNewSession` moves the old chat to `session.history[]` (`{ chat, ended_at, ended_by }`, last 10 kept). The panel shows a "Previous rounds" disclosure.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** A **Revision r3 ▾** menu in the panel header lists revisions. Picking one shows it read-only in the frame, with a "Back to latest" bar.
- [ ] **Step 4: Run** `npm test && npm run smoke`.
- [ ] **Step 5: Commit**: `feat: revision history, change highlights, and md watching`

---

### Task 8: Home dashboard at `/` and state cleanup (S5, S6)

**Files:** new `src/home-page.js`, `public/home-client.js`, `public/home.css`, `src/server.js`, `src/session-store.js`, `src/cli.js`, tests

- [ ] **Step 1: Failing tests:**
  - `GET /` returns the dashboard. `GET /api/sessions` lists `{ key, file, stage, status, workflow_id, updated_at, agent }` (cross-site guard).
  - `POST /api/:key/archive` (same-origin) hides a session. `see-plan prune` removes sessions whose file no longer exists (prints what it removed, `--dry-run` supported).
  - `/events/home` WebSocket pushes `sessions` on any change.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** The dashboard groups sessions by feature. Each feature is a row with a four-step stage tracker (Plan · Interrogation · Implementation · Verification: done / current / locked) and a link to the current stage. Loose sessions get their own list. A "New feature" button opens Task 10's form. Every page gets a top bar link back to `/`.
- [ ] **Step 4: Run** `npm test && npm run smoke`.
- [ ] **Step 5: Commit**: `feat: home dashboard and session cleanup`

---

### Task 9: Stage labels and inference (A3, the labeling request)

**Files:** new `src/stages.js`, `src/session-store.js`, `src/server.js`, `src/cli.js`, `public/chrome-client.js`, `test/stages.test.js`, tests

- [ ] **Step 1: Failing tests** in `test/stages.test.js`:
  - `inferStageFromText`: "this is the interrogation" → interrogation; "grill me on this plan" → interrogation; "let's implement it" → implementation; "verify the build" → verification; "here's the plan" → plan; "I plan to eat" → null (needs a stage phrase, not any use of the word). The table is table-driven and covers about 20 phrases, negatives included.
  - `inferStageFromPath`: `auth.plan.md` → plan, `auth-interrogation.html` → interrogation, `verify-report.html` → verification, `notes.html` → null.
  - `resolveStage({ flag, human, text, path, workflow })` follows the decision-4 order, and returns `{ stage, source }` where `source ∈ flag|human|text|path|workflow`.
  - Store: `setStage(key, stage, source)` refuses to overwrite `source:"human"` or `"flag"` with `text`, `path`, or `workflow` (**human label wins over inference**).
  - Server: the chat prompts route runs `inferStageFromText` on chat-tag prompts and stores the result with `source:"text"` only if the current source is weaker. It broadcasts `{type:"stage", stage, source}`.
  - CLI: `--stage <name>` on open/poll (validated). `see-plan stage <file> [<name>]` reads or sets the stage. Every `session` output object carries `stage` and `stage_source`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** The panel header gets a stage badge with a dropdown (setting it sends `source:"human"`). Inferred labels show "(inferred) · Confirm". Stage-specific `next_step` text lives in `src/stages.js` (e.g. Interrogation: "Ask your questions in the artifact as numbered items with a recommended answer each; after the user answers, update `<plan>` and poll again").
- [ ] **Step 4: Run** `npm test && npm run smoke`.
- [ ] **Step 5: Commit**: `feat: stage labels with explicit, human, and inferred sources`

---

### Task 10: The four-stage workflow (the main request)

**Files:** new `src/workflow-store.js` (state.json `workflows` map), `src/server.js`, `src/cli.js`, `src/claude-launcher.js` (prompts), `src/guidance.js` (new playbooks: `interrogation`, `progress`, `verification`), `public/chrome-client.js`, `src/home-page.js`, tests

- [ ] **Step 1: Failing tests:**
  - `see-plan feature start <name> --requirements <file|->` (or **New feature** on the dashboard, with a requirements text box) creates `workflow { id, name, dir, requirements_file, stages: {plan:{key,status}, …}, current: "plan" }`. It writes `<dir>/<name>.requirements.md`, creates a placeholder `<name>.plan.md` ("Claude is writing the plan…"), opens it as the stage-`plan` session, and (with `--with-claude` or the page button) launches Claude with the Plan prompt.
  - `stage gating`: `connect-claude` for a stage after `current` → 409 `STAGE_LOCKED`.
  - `approve advances`: approving the current stage's session sets that stage `done` and `current` to the next stage. It creates the next stage's artifact from a template (interrogation page / progress page / verification page). The browser gets `{type:"stage-ready", next_url}`, and the panel shows **"Plan approved. Start Interrogation →"**. One click opens the next session's page **and** launches a fresh Claude with that stage's prompt.
  - `verification request-changes` reopens `implementation`, with the comment and failed criteria queued as feedback.
  - `skip`: `POST /api/workflows/:id/skip` (confirm in the UI) marks the stage `skipped` and advances.
  - Each stage stores its own `claude_session_id`. The dashboard and panel show it, linked to the log.
  - Launch prompts per stage (snapshot tests). Each starts with `[see-plan · <name> · <Stage>]`, names the files to read and write, the playbook to follow (`see-plan playbook <id>`), the poll command with `--stage`, and the rule "do not start the next stage yourself".
  - `see-plan feature status <name>` (agent-readable): stages, current stage, and `next_step`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** in this order: workflow store → CLI `feature start/status` → server advance/skip → per-stage prompts and playbooks → panel "next stage" card → dashboard tracker.
- [ ] **Step 4: Run** `npm test && npm run smoke`. Add `scripts/smoke-workflow.js`, which drives all four stages with a fake launcher and fake polls (no real Claude) and prints `WORKFLOW SMOKE OK`. Manually on Windows: start a small real feature (e.g. "add `--quiet` to see-plan stop") end to end.
- [ ] **Step 5: Commit**: `feat: plan → interrogation → implementation → verification workflow`

---

### Task 11: Agent-facing commands and skill (A2, A4)

**Files:** `src/cli.js`, `src/guidance.js`, `skills/my-lavish/SKILL.md`, `test/cli.test.js`

- [ ] **Step 1: Failing tests:** `see-plan status <file>` returns `session { file, status, stage, stage_source, listening, queued_prompts, claude_session_id, revision }` and does **not** take feedback (queued prompts are still there afterward). `--help` lists `status`, `stage`, `feature`, `prune`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** Add `GET /api/:key/status` (read-only). Rewrite `SKILL.md` (≤ 40 lines):
  - when to use see-plan
  - the four stages and their order, and that the agent never starts the next stage itself
  - the poll returns about every 1:50 with `reconnect: true`; run it again at once, without replying to the user (no Bash `timeout` or background run needed)
  - allowing `Bash(see-plan:*)` once
  - always follow `next_step`
  - `see-plan status` for read-only checks
- [ ] **Step 4: Run** `npm test && npm run smoke`.
- [ ] **Step 5: Commit**: `feat: read-only status command and a complete agent skill`

---

### Task 12: Licensing (R1, R2)

**Files:** new `LICENSE`, `NOTICE`, `scripts/third-party-licenses.js`, `package.json`, `README.md`

- [ ] **Step 1:** Add `LICENSE` (MIT, `Copyright (c) 2026 AliA1997`; see decision 9).
- [ ] **Step 2:** Add `NOTICE`: "see-plan / my-lavish-axi is an independent re-implementation of the core review loop of lavish-axi (https://github.com/kunchenguid/lavish-axi), Copyright (c) 2026 Kun Chen, MIT License," followed by lavish-axi's full MIT text. If any file was copied or adapted from lavish-axi (check `public/sdk.js` and the guidance text against upstream), name it in NOTICE. If not, NOTICE states that no upstream code was copied.
- [ ] **Step 3:** `package.json`: add `"license": "MIT"`, `"description"`, `"repository": "github:AliA1997/my-lavish"`, `"homepage"`, `"bugs"`, `"author"`, and `"files": ["bin", "src", "public", "skills", "LICENSE", "NOTICE", "README.md"]`.
- [ ] **Step 4:** `scripts/third-party-licenses.js` walks the production dependency tree (`npm ls --omit=dev --all --json`) and concatenates each package's license file into `THIRD_PARTY_LICENSES.txt`. It fails if any license is outside an allowlist (`MIT, ISC, BSD-2-Clause, BSD-3-Clause, Apache-2.0`). Today that tree is 74 MIT, 4 ISC, and 1 BSD-3-Clause (`qs`). For SEA builds it appends Node.js's `LICENSE`, taken from the exact Node version used to build.
- [ ] **Step 5:** Add a README "License" section and a "Credits" line pointing to NOTICE. Add a test in `test/public-assets.test.js` that `LICENSE` exists and `package.json.license === "MIT"`.
- [ ] **Step 6: Commit**: `chore: MIT license, upstream notice, third-party license report`

---

### Task 13: Make the code SEA-ready (R3)

**Files:** new `src/assets.js`, `src/open-url.js`, `src/version.js`, `src/cli.js`, `src/server.js`, `package.json`, tests

- [ ] **Step 1: Failing tests:**
  - `assets.read(name)` returns `public/<name>` from disk when `isSea()` is false (inject `sea` for tests). It refuses names outside the asset allowlist.
  - `serverSpawnArgs({ isSea })` is `[BIN_PATH, "server"]` normally and `["server"]` in a SEA.
  - `openUrl(url, { platform, spawnFn })` uses `explorer.exe` / `open` / `xdg-open` with the URL as one argv item, and never `shell: true`. It rejects anything that is not `http://127.0.0.1` / `http://localhost`.
  - `VERSION` comes from a generated `src/version.js` (written by `scripts/write-version.js` on `prepare`/build) instead of reading `package.json` at runtime.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** Swap `res.sendFile` for public assets to `res.type(ext).send(assets.read(name))` with the same `Cache-Control`. Remove the `open` dependency.
- [ ] **Step 4: Run** `npm test && npm run smoke`.
- [ ] **Step 5: Commit**: `refactor: SEA-ready assets, spawning, version, and URL opening`

---

### Task 14: Build the executable (R3)

**Files:** new `scripts/build-sea.js`, `sea-config.json`, `package.json` (devDependencies `esbuild`, `postject`; scripts `build:sea`, `smoke:bin`), `scripts/smoke.js` (accepts `--bin <path>`)

- [ ] **Step 1:** `scripts/build-sea.js` does the following in order:
  1. Run `write-version`.
  2. Bundle with esbuild: `bin/see-plan.js` → `dist/see-plan.cjs` (`platform:node`, `format:cjs`, `target:node22`).
  3. Write `sea-config.json` with `"assets"` covering every `public/*` file and `"disableExperimentalSEAWarning": true`.
  4. `node --experimental-sea-config sea-config.json`.
  5. Copy `process.execPath` to `dist/see-plan[.exe]`. On Windows, `signtool remove /s` is optional. On macOS, `codesign --remove-signature`.
  6. Inject with `postject … NODE_SEA_BLOB … --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2` (plus `--macho-segment-name NODE_SEA` on macOS). Then `codesign -s -` on macOS.
  7. Write `dist/THIRD_PARTY_LICENSES.txt`.
- [ ] **Step 2:** `npm run smoke:bin` runs `scripts/smoke.js --bin dist/see-plan[.exe]` against a throwaway port and state dir. It checks that the background server starts from the binary, the page and all assets load, and poll/reply/end work. Expected: `SMOKE OK`.
- [ ] **Step 3:** Manually: copy the exe to a folder outside the repo that has no `node_modules` and run `see-plan examples/plan.html` and `see-plan feature start demo --requirements -`.
- [ ] **Step 4: Commit**: `build: single-executable see-plan via Node SEA`

---

### Task 15: CI and the GitHub Release (R4, the release request)

**Files:** new `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `install.ps1`, `install.sh`, `CHANGELOG.md`, `README.md`, `package.json` (version)

- [ ] **Step 1: `ci.yml`** runs on push/PR to `main`: matrix `{windows-latest, ubuntu-latest, macos-latest} × {node 22, 24}`, with steps `npm ci`, `npm test`, `npm run smoke`. A job on `windows-latest` / node 22 also runs `npm run build:sea && npm run smoke:bin`.
- [ ] **Step 2: `release.yml`** runs on `push: tags: ['v*']` with `permissions: contents: write`:
  1. Check that the tag equals `v${package.json version}`.
  2. Build matrix: `windows-latest` → `see-plan-win-x64.zip`; `ubuntu-latest` → `see-plan-linux-x64.tar.gz`; `macos-14` → `see-plan-macos-arm64.tar.gz`; `macos-13` → `see-plan-macos-x64.tar.gz`. Each archive holds the binary, `LICENSE`, `NOTICE`, `THIRD_PARTY_LICENSES.txt`, `README.md`, and `skills/my-lavish/`. Each build runs `smoke:bin` before uploading.
  3. A final job downloads the artifacts, writes `SHA256SUMS`, and runs `gh release create "$TAG" --title "see-plan $TAG" --notes-file <CHANGELOG section> <archives> SHA256SUMS install.ps1 install.sh`.
- [ ] **Step 3: `install.ps1`** (`irm https://github.com/AliA1997/my-lavish/releases/latest/download/install.ps1 | iex`): download the win-x64 zip and `SHA256SUMS` from the latest release, check the hash, extract to `$HOME\.see-plan\bin`, add it to the user PATH (`[Environment]::SetEnvironmentVariable(..., "User")`) if missing, copy the skill to `~/.claude/skills/my-lavish/` only if the user agrees (`-InstallSkill`), and print `see-plan --version`. **`install.sh`** does the same for macOS/Linux, with `~/.see-plan/bin` and a PATH hint for the user's shell rc.
- [ ] **Step 4: README** gets an "Install" section, in this order: (1) the one-line installers, (2) a manual download from Releases, (3) `npm install -g github:AliA1997/my-lavish`, (4) from source (`npm link`). Add the SmartScreen note for the unsigned exe. Move the old `npm unlink -g my-lavish-axi` note to an "Upgrading from 0.1" line.
- [ ] **Step 5:** Bump `version` to `0.2.0`, write the `CHANGELOG.md` entry, commit `release: v0.2.0`, then `git tag v0.2.0 && git push origin main v0.2.0`. **This step publishes outward. Confirm with the user before pushing the tag.**
- [ ] **Step 6: Verify** that the Release page lists 4 archives, `SHA256SUMS`, and both installers. Run `install.ps1` on a clean Windows user profile and check that `see-plan --version` prints `0.2.0` in a new terminal. Run `see-plan examples/plan.html` from the installed binary.

---

## Order and dependencies

```
T0 ─► T1 ─► T2 ─► T3 ─► T4 ─┬─► T5 ─┐
                            ├─► T6 ─┼─► T9 ─► T10 ─► T11
                            ├─► T7  │
                            └─► T8 ─┘
T12 (any time after T0) ─► T13 ─► T14 ─► T15 (after T11, so the release ships the workflow)
```

Tasks 1–3 fix "can the user connect Claude from the UI" and "stay connected" (the silent 1:50 reconnect cycle is Tasks 1–2) and should ship first, as `v0.1.1` if you want an early release. Tasks 5–6 cover session and plan feedback. Tasks 9–10 add the four-stage workflow and labeling. Tasks 12–15 cover licensing and the release.
