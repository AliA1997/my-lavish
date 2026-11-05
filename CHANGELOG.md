# Changelog

## [Unreleased] - planned for a later release

The rest of the 2026-11-03 plan (`docs/superpowers/plans/2026-11-03-logs-sessions-plans-fixes.md`, Tasks 2–4): log hand-off, session management and plan management. Its stage inference for plan folders and its Claude-session cache shipped early (0.3.0, and again in 3.2.0).

## [3.3.0] - 2026-11-04

Phase 1 of `docs/superpowers/plans/2026-11-04-trust-headless-paths-multi-output.md`: standard state paths. Not breaking: existing installs keep working with no data loss.

### Standard paths
- New `src/paths.js` owns every see-plan path. State, data (`error-log.json`), logs (`server.log`), the runtime file and the optional `config.json` now follow each platform's standard: XDG on Linux, `~/Library` on macOS (explicit `XDG_*` wins), `%LOCALAPPDATA%` / `%APPDATA%` on Windows.
- Precedence per path: env override, then the **legacy folder** (`~/.my-lavish-axi`, `~/claude-errors/error-log.json`) while it exists and the new one doesn't, then the platform default.
- New `MY_LAVISH_DATA_DIR`. `MY_LAVISH_STATE_DIR` now also moves `server.log` and the runtime file.
- New **`see-plan paths [--json]`**: every path and the rule that chose it. SKILL.md, the poll `next_step`, the `/claude` tip and the panel take the error log path from it instead of a hardcoded `~/claude-errors`.
- New **`see-plan migrate [--dry-run]`**: stops the server, copies the legacy data, checks it (JSON parses, counts match), and renames the old ones to `*.migrated-<date>`. It never deletes, and refuses when the new location already has data. Bare `see-plan` prints `legacy_paths: run see-plan migrate` while legacy paths are in use.
- `/health` no longer returns `state_dir`.

## [3.2.0] - 2026-11-04

The v0.3.1 release was reverted, and its error-log tabs and severity were planned again (`docs/superpowers/plans/2026-11-04-project-aware-error-tabs.md`) with one new rule: **the view depends on the folder you start it in.** Everything listed under 0.3.0 and 0.3.1 below is back, except for the changes noted here. The version jumps from 0.3.1 straight to 3.2.0; there are no 1.x or 2.x releases.

### Project-aware error logs
- New command **`see-plan error-logs`** (`--dir`, `--no-open`) opens the error-log view for the current folder. Bare `see-plan` in a terminal also prints it as `error_logs`.
- **In a project folder** (the nearest folder with `.git`, `docs/superpowers/` or `.superpowers/`; never your home folder), `/errors?project=<key>` shows all four tabs: Session Error Logs, Plan Error Logs, Plans and Sessions.
- **Anywhere else**, `/errors` shows **only the Sessions tab** (the 75 most recent Claude sessions), with links to projects you opened before. The other tabs aren't rendered.
- The **Plans** tab now lists the project's **superpowers plans** (`docs/superpowers/plans/`, the newest 50 by their date prefix or creation time) with title, review status (including *Not opened*) and error counts. **Open** starts a review session for a plan straight from the tab. It replaces 0.3.0's list of plan-stage review sessions.
- New routes: `POST /api/projects` (CLI only; registers a project root), `GET /api/projects`, `GET /api/projects/:project/plans` and `POST /api/projects/:project/plans/open` (same origin; only a file name from the listing). `GET /api/errors/summary` takes `?project=`.
- Registered projects are kept in `state.json` (at most 50).

### Breaking
- `GET /api/plans` was removed; use `GET /api/projects/:project/plans`.
- `/errors` without a registered `?project=` shows only Sessions.

## [0.3.1] - 2026-11-04

First release with the 0.3.0 changes (error severity and the tabbed `/errors` page, listed under 0.3.0 below), plus these fixes.

### Fixes
- **Plans tab was empty for existing plans.** Review sessions created before 0.3.0 had no stage saved, so plans in a `plans/` or `specs/` folder were missing from the Plans tab and its count until they were reopened, and their errors were filed under Session Error Logs. An unlabeled session now takes its stage from its path when the lists are read. Nothing is rewritten in `state.json`, and a stage you or the agent set still wins.
- **Severity filter chips on `/errors` could do nothing.** Clicking a chip while the tab was still loading changed the selection but never reloaded the list. A newer load now replaces the one in flight.

## [0.3.0] - 2026-11-04

### Error severity
- Logging an entry as an error now needs a **severity**: Low, Medium, High or Send to IT, each with a color and a one-line meaning. Keys 1–4 pick one in the `/claude` dialog and the panel popover. High and Send to IT also need a reason; the server answers `VALIDATION_ERROR` without one.
- Records gain `severity`, plus `context` (`plan` or `session`), `review_key` and `stage`, worked out by the server from the Claude session id when the entry is logged. A duplicate keeps the first severity and returns it.
- Entries already logged show a severity badge and, in the dialog, their saved severity.

### Error logs page
- New page `/errors` with four tabs: **Session Error Logs**, **Plan Error Logs**, **Plans** (the latest 50) and **Sessions** (the latest 75 Claude sessions), with counts, severity filter chips, expandable entries and **Load more**.
- Records from before 0.3.0 show as **Unrated** and can be given a severity once (**Rate…**).
- New routes: `GET /api/errors`, `GET /api/errors/record`, `GET /api/errors/summary`, `POST /api/errors/rate` and `GET /api/plans`. `GET /api/claude-sessions` takes `limit` (up to 75) and adds the review session, stage and error counts.
- The dashboard and the Claude log page link to it.

### Also
- Files in a `plans/` or `specs/` folder get the Plan stage from their path, on create and on resume, without overriding a stage you or the agent set.
- The Claude session list is cached (30 s for the file list; titles until a transcript changes).
- The parsed error log is cached until the file changes; the server logs its size at startup.
- `MY_LAVISH_ERROR_LOG` points the server at another error log file (used by the smoke test).

## [0.2.1] - 2026-11-03

### Error log
- On the Claude log page (`/claude`), clicking an entry now opens a confirmation dialog instead of writing at once. It shows a preview of the entry and an optional *Why is this an error?* box. **Log as error** or Ctrl/Cmd+Enter saves it; Esc or **Cancel** leaves the log untouched, and focus returns to the entry.
- Records in `~/claude-errors/error-log.json` gain a `reason` field (a trimmed string up to 2,000 characters, or `null`).
- Logging an entry that is already there keeps the first reason. The response says `already_logged` and returns the saved reason, and the dialog shows it read-only.
- In the panel, the log popover's note is saved as the reason when you choose **Log as error** or **Both**. The box is now labeled "Note to agent / reason (optional)".

### Fixes
- Session routes (`/api/:key/...`) answer 404 for any key that is not 16 hex digits. Before, a key such as `__proto__` could reach the session store.

## [0.2.0] - 2026-11-01

First release with a standalone executable. Install with one line (see the README), or download an archive below and check it against `SHA256SUMS`.

### Stay connected
- Agent polls return on their own about every 1:50 (under Claude Code's 120 s Bash timeout) and the agent re-polls at once. The server caps agent polls too, for older CLIs.
- The panel shows "connected" through these cycles: a 20 s grace period hides the gap, notes sent in the gap reach the next poll, and Connect Claude cannot start a second Claude meanwhile.

### Connect Claude
- One connection card: idle, starting (with a timer and Cancel), connected, working, stuck (after 45 s, with recovery steps and a copyable `Bash(see-plan:*)` allow-rule), and unsupported (with a command to paste).
- Works on macOS (Terminal via osascript) and Linux (x-terminal-emulator, gnome-terminal, konsole, xterm), falling back to a copy-paste command.
- **Resume last session** restarts the previous Claude conversation with `--resume`.
- Launch cooldown is per session; launch prompts are labeled `[see-plan · <feature> · <Stage>]`.

### Four-stage features
- `see-plan feature start <name> --requirements <file|->` (or **New feature** on the dashboard) runs Plan → Interrogation → Implementation → Verification, each with its own fresh Claude session.
- A stage opens only when the one before it is approved or skipped. A rejected verification sends the work back to implementation with the issues queued.
- Stage labels come from `--stage`, the panel's stage menu, the user's words ("this is the interrogation"), or the file name; an inferred label never overrides one the human set.
- New playbooks: `interrogation`, `progress`, `verification`.

### Feedback and plan management
- **Session feedback**: 👍/👎 with categories and a note, queued for the agent and logged to `feedback.jsonl`.
- **Approve / Request changes** on a plan, and comments on the whole plan.
- Revision history (last 20) with a read-only viewer; changed blocks are highlighted after a reload; editing a `.md` plan refreshes the page.
- **Start fresh** keeps earlier rounds under "Previous rounds"; **Resume (keep history)** reopens an ended session.
- Claude log entries open a note popover: send to the agent, log as an error, or both. The server writes the error log; the agent is never asked to.

### Panel and dashboard
- Dashboard at `http://127.0.0.1:4388/` listing features (with a stage tracker) and review sessions, with Archive.
- Queued notes stay above the tabs and survive closing the tab. End and Send & End sit behind a More menu with a confirmation. First-run tip, ARIA tabs with arrow keys.

### Commands
- `see-plan status <file>` (read-only), `see-plan stage <file> [name]`, `see-plan feature start|status`, `see-plan prune [--dry-run]`, and `--stage`, `--agent` flags.
- Bare `see-plan` in a terminal no longer opens a browser.

### Packaging and license
- MIT license, with a NOTICE crediting lavish-axi. Archives include `THIRD_PARTY_LICENSES.txt`.
- Standalone executables for Windows x64, Linux x64, macOS arm64 and x64 (Node.js 22 single executable application), plus `install.ps1` and `install.sh`.
- The `open` dependency was replaced by a small local-only URL opener.

## [0.1.0] - 2026-10-24

Initial version: annotate an HTML or Markdown plan in the browser and send the feedback to a polling agent.
