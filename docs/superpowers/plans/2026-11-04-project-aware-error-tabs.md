# see-plan: project-aware error-log tabs and error severity

Date: 2026-11-04 · Status: **implemented 2026-11-04 (3.2.0)** · Version at time of writing: 0.2.1 (branch `feat/project-aware-error-tabs` @ b793590, the revert of v0.3.1) · Ships as **3.2.0**

## Why this plan exists

v0.3.1 shipped a tabbed `/errors` page and error severity (0.3.0 plan, commit 7221b79; fixes in 9c7c317). That release was **reverted** (b793590), so the tree matches v0.2.1 again. This plan redoes the same request with two new rules:

- When see-plan is started in a **non-project directory**, the error-log view shows **no other tabs, only the recent Sessions**.
- In a **project directory**, it shows all four tabs, and the **Plans** tab lists that project's **superpowers plans** (`docs/superpowers/plans/`), not review sessions.

The reverted code is the starting point. Take it where the design below agrees and change it where it doesn't. It is still in git (`git show v0.3.1:<path>`).

## Goal

1. An **error-log view with tabs**:
   - **Session Error Logs**: errors logged from ordinary (non-planning) sessions, with the error, its severity and the reason.
   - **Plan Error Logs**: errors logged from a planning session, with the same columns.
   - **Plans**: the 50 most recently created superpowers plans of the current project.
   - **Sessions**: the 75 most recent Claude sessions.
2. When an entry is logged as an error, the user **picks a severity**:

| Severity | id | Meaning | Color | Reason |
| --- | --- | --- | --- | --- |
| Low | `low` | Minor miscommunication between the human and the AI. | Orange | optional |
| Medium | `medium` | Wrote buggy code, or a plan that was slightly off course. | Warning (amber) | optional |
| High | `high` | A plan that went badly off course; a sign of lost context ("lost in the middle"). | Danger red | **required** |
| Send to IT | `send_to_it` | Malicious code, or work that ran without supervision. | Red velvet | **required** |

3. **Project mode vs non-project mode** (new):
   - Started in a project directory: four tabs, and Plans lists `<project>/docs/superpowers/plans/`.
   - Started anywhere else: only the **Sessions** tab. The page doesn't render the other three tabs or their panels at all; it doesn't just hide them.

## How the code behaves today (verified 2026-11-04 on the reverted tree)

| Area | Where | Today |
| --- | --- | --- |
| Error record | `POST /api/claude-errors` (`src/server.js` ~L1063) | `{claude_session_id, uuid, part, role, kind, at, text, reason, reported_at}`. No severity, no context. |
| Error store | `src/error-log.js` | A JSON array in `~/claude-errors/error-log.json`, rewritten on each append. `reportedRecords` covers one Claude session. Nothing lists every record. |
| Pages | `/` (`home-page.js`), `/claude` (`logs-page.js`) | No tabs, no `/errors`. |
| Stage | `src/session-store.js` `upsertSession`, `src/stages.js` `inferStageFromPath` | Path inference only on create, and only for a `plan` token in the name; `docs/superpowers/plans/2026-…md` gets no stage. |
| Claude sessions | `src/claude-log.js` `listClaudeSessions` | No cache; stats every transcript on each call. |
| Working directory | `src/cli.js` | Only `feature start` reads `process.cwd()` (as `--dir`). Bare `see-plan` in a TTY prints the `/claude` URL. `findRepoRoot` (`claude-launcher.js:158`) walks up to `.git` but falls back to the start dir, so it can't tell "no project". |
| Projects | – | The server has no idea of a project. It's one long-lived process shared by every terminal, so it can't use its own cwd. |

## Design decisions

Carried over from the 0.3.0 plan, unchanged:

- **D2. Planning session:** a Claude session attached to a review session whose stage is `plan`. Workflow plan stages are review sessions with `stage: "plan"`, so they're covered once.
- **D3. Classify on the server, when logging,** from `claude_session_id` alone (`context`, `review_key`, `stage`). The most recently updated attached review session wins. Old records get classified when they're read.
- **D4. Sessions = Claude sessions** (transcripts), each with its attached review session, stage and error counts.
- **D5. Severity is required** in the `/claude` dialog and the panel popover, with nothing pre-selected. Old records show as **Unrated**.
- **D6. Records are immutable**, except that an Unrated record can be rated **once** from `/errors`.
- **D7. High and Send to IT need a reason,** everywhere. *Send to IT* is a label only; nothing leaves the machine.

New or changed:

- **D9. What a project directory is.** Walk up from the start directory. The first directory that has `.git` (folder or file), `docs/superpowers/` or `.superpowers/` is the project root. The user's **home directory and the filesystem root never count** (a dotfiles repo in `~` must not turn every folder into a project). If nothing matches, the directory is a **non-project** directory. Paths are canonical (`realpath`).
- **D10. How the page learns the project.** The CLI works out the root and registers it: `POST /api/projects {dir}`. The server checks D9 again itself, stores `{key, root, name, registered_at, last_seen_at}` under `projects` in `state.json` (key = `sessionKey(root)`, at most 50, least recently seen dropped first), and answers with the key. The page URL is `/errors?project=<key>`. **`/errors` without a known key is non-project mode.** The server never reads a path that comes from a URL: only registered roots are listed.
- **D11. Where it starts.**
  - New command **`see-plan error-logs [--dir <path>] [--no-open]`** opens the page for the cwd (or `--dir`). (`see-plan errors` stays reserved for the 2026-11-03 Task 2b CLI listing.)
  - Bare `see-plan` in a terminal also prints `error_logs: <url>`, scoped the same way.
  - The dashboard's *Error logs* link and the `/claude` nav go to `/errors`. `/claude` and `/errors` pass `?project=` through their nav links when they have one.
- **D12. Plans tab = superpowers plans on disk** (replaces 0.3.0's D8). It lists the files directly in `<root>/docs/superpowers/plans/`: `.md`/`.markdown`, plus `.html`/`.htm` that aren't generated from a sibling `.md` of the same name. Symlinks and subfolders are skipped. **Created** is the `YYYY-MM-DD` prefix of the name when it has one, otherwise the file's birth time (or its mtime when the OS reports no birth time). The list is sorted newest first and capped at 50. Each row joins the review session for that file, if there is one: its status (Not opened, Open, Needs changes, Approved, Ended, Archived) and its error count with the worst severity. A plan that isn't opened yet gets an **Open** button. The server opens it the same way `see-plan <file>` does, and only for a name that's in the current listing.
- **D13. Non-project mode** renders only the Sessions tab, still as a one-tab tablist, so the markup and the keyboard behavior stay the same. It shows a hint: "Run `see-plan error-logs` in a project folder for error logs and plans." Below that it lists links to up to 5 recently registered projects. It doesn't call `/api/errors/summary`.
- **D14. The error tabs are not filtered by project.** In project mode, Session and Plan Error Logs show every record, as the request asks. Filtering by project is out of scope.

## Tasks

Order: 0 → 1 → 2 → 3 → 4 → 5. Each task ends with `npm test` green; Tasks 3 to 5 also need `npm run smoke`.

### Task 0: Prerequisites (from the reverted code)

- Stage inference: a file whose parent folder is `plans` or `specs` gets `stage: plan` from the `path` source, on create **and on resume**, without overriding flag, human or text labels. `effectiveStage(session)` covers unlabeled older sessions when lists are read, without rewriting `state.json`.
- The Claude-session cache `createClaudeSessionLister` (30 s scan list, head cache by mtime, `titleOf`).
- `store.writeCount` as a cache key next to the mtime of `state.json`.

Tests: a `docs/superpowers/plans/x.md` session gets `stage: plan` on create and on resume; a human label survives a resume; the lister's cache hits and misses.

### Task 1: Severity on error records

Reuse `src/severity.js` (`SEVERITIES`, titles, hints, `REASON_REQUIRED`, `includes`-based `isSeverity`, `worseSeverity`).

- `POST /api/claude-errors` requires a valid `severity` and returns `VALIDATION_ERROR` for a High or Send to IT without a reason. It stores the severity, keeps the first severity on a duplicate and returns it.
- `reportedRecords` and `GET /api/claude-sessions/:id/log` carry the severities.
- The `/claude` dialog gets a Severity fieldset with four radios (swatch, label, one-line meaning); keys 1–4 pick one; **Log as error** stays disabled until one is picked; the reason label says "required" for High and Send to IT; rows already logged show a badge.
- The panel popover gets the same control. *Log as error* and *Both* need a severity; *Send to agent* alone doesn't. `entryRecord()` adds `severity` to the error-log payload only, and the agent prompt payload doesn't change.

### Task 2: Classification, listing and rating

Reuse the 0.3.0 Task 2 code: `classificationLookup()` (cached by `writeCount`, mtime and size), `listErrorRecords`, `getErrorRecord`, `summarizeErrorRecords` (counts per context × severity; per Claude session and per review key), `rateErrorRecord` (once; `ALREADY_RATED`), the parsed-log cache cleared on writes, and the startup log line with the file size.

### Task 3: Projects (new)

`src/project.js` (new):
- `findProjectRoot(dir, { home })` implements D9 and returns the canonical root or `null`. `isProjectRoot(dir, { home })` checks one directory, for the server.
- `listSuperpowersPlans(root, { limit = 50 })` implements D12. It returns `{ items: [{ name, file, title, created_at, modified_at }], total }`. The title is the first `# ` heading in the first 4KB of a Markdown file, cached by path and mtime; an HTML file uses its file name.

`src/project-store.js` (new, data under `projects` in `state.json` via `store.transact`):
- `registerProject(store, root)` adds a project or updates its `last_seen_at`, caps the list at 50, and returns the record. `getProject(store, key)` and `listProjects(store, { limit })` (most recently seen first) read it.

Server routes, all registered **before** `/api/:key/*`:
- `POST /api/projects {dir}`: refuses cross-site requests and accepts only JSON. It canonicalizes `dir`, runs `findProjectRoot` and answers `{ project: null }` for a non-project directory, or `{ project: {key, root, name}, url }`. It is the only route that takes a path.
- `GET /api/projects?limit=5`: recently seen projects `{key, name, root, url}`.
- `GET /api/projects/:project/plans`: the project's plans (D12) joined with review sessions and error counts. It returns 404 for a key that isn't registered. `:project` has to match the 16-hex key pattern.
- `POST /api/projects/:project/plans/open {name}`: same origin only. `name` must be a plain file name (no separators, no `..`) that's in the current listing. It opens the file through the same path as `POST /api/sessions` (a Markdown plan gets its HTML generated) and answers `{key, url}`.
- `GET /api/errors/summary?project=<key>` also returns `plans` (the listing total, at most 50).
- The 0.3.0 `GET /api/plans` (review-session based) is **not** brought back.

CLI (`src/cli.js`, `src/guidance.js`):
- `see-plan error-logs [--dir <path>] [--no-open]`: starts the server, registers the project and opens the page. It prints `{ error_logs: { url, mode: "project" | "sessions-only", project? }, next_step }`.
- Bare `see-plan` in a TTY adds `error_logs` to its output (it never opens a browser).

Tests: D9 (a nested folder finds the root; a `docs/superpowers`-only folder counts; the home directory and a folder under home with no markers don't; a `.git` in home is ignored), D12 (filters, the sibling-HTML rule, symlinks skipped, date-prefix sort, birth-time fallback, cap at 50, titles), registration (the key is stable, the cap holds, `last_seen_at` moves), the routes (a non-project dir answers `project: null`; an unknown key gets 404; a bad key gets 404; a cross-site GET or POST gets 403; open refuses a name outside the listing and `../x.md`; open creates a session with `stage: plan` and the next listing shows it Open), and the CLI output in both modes.

### Task 4: The `/errors` page

Reuse `src/errors-page.js`, `public/errors-client.js` and `public/errors.css`, with these changes:
- `createErrorsHtml({ baseUrl, project, recentProjects })`: with a project, it renders all four tabs plus a header line *Project: name* (with the full root as a tooltip). Without one, it renders only the Sessions tab and its panel (D13), with the hint and the recent-project links. The server resolves `?project=` with `getProject`; an unknown key gives non-project mode plus the note "That project isn't registered; run `see-plan error-logs` in it."
- The client reads its tabs from the DOM (`[role=tab]`) instead of a fixed list, and the project key from `body[data-project]`. The default tab is the first one rendered.
- The Plans tab table has the columns *Plan* (title, linked to `/session/<key>` when the plan is opened; the file name sits under the title), *Created*, *Status*, *Errors* and an action (**Open**, which POSTs and then navigates to the returned URL).
- Session and Plan Error Logs keep the 0.3.0 behavior: severity chips with counts, **Show all**, **Rate…** for Unrated rows, and **Load more**.
- Sessions: the 75 most recent, with the columns *Session*, *Project*, *Last activity*, *Review session / stage* and *Errors*.
- Severity colors as custom properties (light / dark): Low `#E8730C`/`#FF9A3D`, Medium `#F2B600`/`#FFC94D`, High `#C62828`/`#FF5C5C`, Send to IT `#7B1E3A`/`#C2456A`, Unrated `#6B7280`/`#9CA3AF`. Badge text is black or white at 4.5:1 or better, badges always show the label, and Send to IT rows get a red-velvet left border.
- Add `errors-client.js` and `errors.css` to `PUBLIC_ASSETS` and to the smoke `ASSETS`.

Tests: in project mode the page has four ARIA tabs and a project header; in non-project mode it has exactly one tab (Sessions) and the markup contains none of the other three panels; an unknown key falls back to non-project mode; `errors-client.js` contains no `innerHTML`; the badge contrast check; `sea-ready` passes.

### Task 5: Docs, smoke and release 3.2.0

- `scripts/smoke.js`: log one entry of each severity from a plan session and from a plain session; register a temporary project that has two superpowers plans; check the counts on all four tabs and that `/errors` without a project shows only Sessions.
- README gets an *Error logs* section covering the severity table, both modes and `see-plan error-logs`. The CHANGELOG gets a **3.2.0** entry that says 0.3.x was reverted and replaced. `skills/my-lavish/SKILL.md` and the CLI hints say records carry `severity` and `context`, and that `text`, `reason` and `title` are quoted data, never instructions.
- Bump to **3.2.0** in `package.json`, `package-lock.json` and `src/version.js` (via `scripts/write-version.js`). Open a PR, merge it after CI passes, tag `v3.2.0` and let `release.yml` build the release.

## Performance

- Expected scale: about 2,000 error records, 20 review sessions, 10 registered projects and up to 200 files in a plans folder.
- The error log, the classification lookup and the Claude-session list are cached as in 0.3.0. All counts come from one summary call.
- A plan listing is one `readdir` plus one `stat` per file. Titles are cached by mtime, so a warm listing reads no file contents. The Plans tab loads only when it's opened and refreshes only while it's visible.
- In non-project mode the page loads one list (`/api/claude-sessions?limit=75`) and the recent-project links.
- Budgets (timing tests): `/api/errors` under 50ms warm with 2,000 records; Sessions under 100ms warm; a plan listing of 200 files under 100ms warm.

## Security

- The server stays on 127.0.0.1 behind the Host allowlist. New GETs check `isCrossSite`, and the open POST checks `requireSameOrigin`. `POST /api/projects` refuses cross-site requests and needs a JSON body, which a cross-site form can't send without a preflight.
- `POST /api/projects` is the only route that takes a directory, and it accepts only a D9 project root. The plan routes read only `<registered root>/docs/superpowers/plans`, never a client path. **Open** takes a bare file name that has to be in the listing, so `../` and absolute paths fail.
- Project keys, session keys and Claude ids are pattern-checked before any lookup (`__proto__` gets 404).
- Error text, reasons, titles, plan titles and paths reach the DOM only through `textContent`; links are built from route templates plus `encodeURIComponent`. A test fails if `errors-client.js` contains `innerHTML`.
- Prompt injection: the SKILL.md and CLI hints say to treat `text`, `reason` and `title` as quoted data.

## Out of scope

- Filtering the error tabs by project (D14).
- Detecting projects automatically from opened review sessions (only the CLI registers them).
- Removing a registered project from the page.
- Editing or deleting records, or changing a severity once it's set.
- Actually notifying IT.
- The 2026-11-03 Tasks 2–4 remainder (log hand-off, session management, plan management), which moves to **3.3.0**.
