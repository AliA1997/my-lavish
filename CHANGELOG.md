# Changelog

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
