# see-plan: tabbed error-log view and error severity

Date: 2026-11-04 · Status: **implemented 2026-11-04 (0.3.0)** · Version at time of writing: 0.2.1 (repo `main` @ 04adc31) · Ships as **0.3.0**

## Goal

1. Add a new **error-log view with tabs**:
   - **Session Error Logs**: errors logged from ordinary (non-planning) sessions. Shows the error, its severity and the reason.
   - **Plan Error Logs**: errors logged from a planning session. Same columns.
   - **Plans**: the 50 most recently created plans.
   - **Sessions**: the 75 most recent Claude sessions.
2. When an entry is logged as an error, let the user **choose a severity**:

| Severity | id | Meaning | Color | Reason |
| --- | --- | --- | --- | --- |
| Low | `low` | Minor miscommunication between the human and the AI. | Orange | optional |
| Medium | `medium` | Wrote buggy code, or a plan that was slightly off course. | Warning (amber) | optional |
| High | `high` | A plan that went badly off course; a sign of lost context ("lost in the middle"). | Danger red | **required** |
| Send to IT | `send_to_it` | Malicious code, or work that ran without supervision. | Red velvet | **required** |

## Relation to the 2026-11-03 plan

Only Task 1 (0.2.1) of `2026-11-03-logs-sessions-plans-fixes.md` has shipped. This plan **ships first, as 0.3.0**. It brings forward two pieces of that plan as Task 0 below. The rest of the 2026-11-03 Tasks 2–4 moves to **0.4.0**; update that plan's header when this one lands.

## How the code behaves today (verified 2026-11-04)

| Area | Where | Today |
| --- | --- | --- |
| Error record | `POST /api/claude-errors` (`src/server.js` ~L1063–1110) | `{claude_session_id, uuid, part, role, kind, at, text, reason, reported_at}`. No severity and no link to a review session or stage. |
| Error store | `src/error-log.js` | A JSON array in `~/claude-errors/error-log.json`, rewritten whole on each append (serialized queue, temp file plus rename). Duplicates by `claude_session_id + uuid:part`; the first reason is kept. `reportedRecords` returns refs and reasons for **one** Claude session. Nothing lists every record. |
| Log dialog | `src/logs-page.js` `<dialog id="logDialog">`, `public/logs-client.js` | Preview plus an optional reason. No severity. |
| Panel popover | `public/chrome-client.js` `entryRecord()` ~L1190, `src/chrome-page.js:174` | *Log as error* / *Both* send the note as the reason. No severity. `entryRecord()` also builds the agent prompt payload (`chrome-client.js` ~L1225), so a change to it touches *Send to agent* too. |
| Stage | `src/session-store.js` `upsertSession` L92–127, `src/stages.js` | Set by flag or path when the session is created, and changed later by a resume flag, by text inference (`server.js` ~L417), by `POST /api/:key/stage` (~L509) and by the poll (~L1242). Sources, strongest first: flag, human, text, path, workflow. |
| Workflows | `src/workflow-store.js` | A workflow's plan stage is **already a review session** with `stage: "plan"` and a `workflow_id`, so review sessions cover workflows with no separate lookup. |
| Statuses | `src/session-store.js` | `open`, `feedback`, `ended` (with `ended_by`: user / agent / approved), plus an `archived` flag. |
| Sessions | `src/claude-log.js` `listClaudeSessions` L214, `GET /api/claude-sessions` | Stats every transcript on each call; default limit 20; no cache. |
| Pages | `/` dashboard (`home-page.js`, nav at L19), `/claude` (`logs-page.js`) | No tabs anywhere; `/claude` has no nav header. |
| Assets | `src/assets.js` `PUBLIC_ASSETS`, `scripts/smoke.js:16` `ASSETS` | `PUBLIC_ASSETS` drives the SEA build; `sea-ready.test.js` checks it matches `public/` exactly. `scripts/build-sea.js` needs no edit. |

## Design decisions (settled in interrogation)

- **D1. Where the view lives:** a new page, **`/errors`**, linked from the dashboard nav (`home-page.js:19`) and from a new nav header on `/claude`. It uses a WAI-ARIA tablist with four tabs. The active tab is kept in the URL hash (`#session-errors`, `#plan-errors`, `#plans`, `#sessions`) so links and reloads land on the same tab. The default is `#session-errors`.
- **D2. What a "planning session" is:** a Claude session is a planning session when it is attached to a review session whose `stage` is `plan`. Workflow plan stages are covered, because they are review sessions with `stage: "plan"`; they are never counted twice. Interrogation, implementation and verification errors are **session errors**.
- **D3. Classify on the server, when logging.** The server works out `context`, `review_key` and `stage` from `claude_session_id` **alone**, and stores them on the record. It never takes context, stage or a review key from the client, and there is no `entry.key`. If several review sessions are attached to the same Claude session, the **most recently updated** one wins. No `claude_sessions[]` history is kept. Records saved before 0.3.0 have no `context` and are classified **when read**, using whatever the Claude session is attached to today (best effort; accepted risk).
- **D4. "Sessions" means Claude sessions** (transcripts), the same list `/claude` uses. Each row also shows the attached review session and stage, if there is one.
- **D5. Severity is required** in the dialog and the popover, with no default chosen, so the user has to pick one. Old records without a severity show as **Unrated** (grey).
- **D6. Records stay immutable**, with one exception: an **Unrated** record can be given a severity **once**, from the `/errors` tab. Rating may also add a reason, and must when the rating is High or Send to IT and the record has no reason.
- **D7. High and Send to IT need a reason**, in the dialog, the popover and the rating. The UI won't submit without one, and the server returns `VALIDATION_ERROR`. Nothing is sent anywhere automatically (no email or webhook); *Send to IT* is only a marker in the log.
- **D8. What counts as a plan (Plans tab):** a review session with `stage === "plan"` **and** a file that is either under `docs/superpowers/plans/` or `docs/superpowers/specs/`, or has a parent folder named `plans` or `specs`, or is a New-feature `*.plan.md` file. Other plan-stage sessions still count for D2 but don't show on the Plans tab.

## Tasks

Order: 0 → 1 → 2 → 3 → 4. Each task ends with `npm test` green and `npm run smoke` passing. Work on a feature branch, not `main`.

### Task 0: Prerequisites (brought forward from 2026-11-03)

- **Stage inference for plan folders** (2026-11-03 Task 4): a file in a `plans/` or `specs/` folder, or a `*.plan.md` file, gets `stage: plan` from the `path` source. Inference runs on create **and on resume**, without overriding a stronger source (flag, human, text). Without this, `docs/superpowers/plans/*.md` sessions never count as plans.
- **Claude-session cache** (2026-11-03 Task 3): a cached, sorted stat list (30s) plus a title cache keyed by id and mtime. The Sessions tab reads 75 transcript heads and must not scan the disk on every poll.

Tests: a `docs/superpowers/plans/2026-11-04-x.md` session gets `stage: plan` on create and on resume; a `human` stage is not overwritten on resume; the session list hits the cache when mtimes are unchanged.

### Task 1: Severity on error records

Shared module (`src/severity.js`, new; plain data so the client can copy it):
- `SEVERITIES = ["low", "medium", "high", "send_to_it"]`, `SEVERITY_TITLES`, `SEVERITY_HINTS` (the meanings in the Goal table), `REASON_REQUIRED = ["high", "send_to_it"]`.
- `isSeverity(v)` is `typeof v === "string" && SEVERITIES.includes(v)`. Never an object lookup, so `__proto__` and `constructor` fail.

Server (`POST /api/claude-errors`):
- `entry.severity` is **required** and must pass `isSeverity`; otherwise `VALIDATION_ERROR` "severity must be one of low, medium, high, send_to_it".
- `high` or `send_to_it` with an empty (after trim) reason returns `VALIDATION_ERROR` "High and Send to IT need a reason" (D7).
- Store `severity` on the record.
- Duplicates: keep the first severity, as with the first reason. The duplicate result `append` returns, and the `already_logged` response, include the saved `severity`.
- Add `severity` to what `reportedRecords` returns and to the `GET /api/claude-sessions/:id/log` response, so already-logged rows can show it.

`/claude` dialog (`src/logs-page.js`, `public/logs-client.js`, `public/logs.css`):
- Add a `<fieldset>` with the legend **Severity** and four radio buttons. Each shows a colored swatch, its label and its one-line meaning. None is checked at first. **Log as error** stays disabled until one is picked. Keys 1–4 pick a severity while the dialog has focus.
- When *High* or *Send to IT* is picked, mark the reason as required and change its label to "Why is this an error? (required for High and Send to IT)".
- An entry that's already logged shows its saved severity read-only. Rows that are already logged get a small severity badge.
- Add a nav header to `/claude` with links to the dashboard and `/errors`.

Panel popover (`public/chrome-client.js`, `src/chrome-page.js`):
- Add the same four-option severity control. *Log as error* and *Both* need a severity (and a note for High / Send to IT); *Send to agent* alone doesn't.
- `entryRecord()` adds `severity` to the **error-log** payload only. Keep the agent prompt payload (~L1225) unchanged, and test that it is.

Tests (`test/server-loop.test.js`, next to the 0.2.1 reason tests): each valid severity; missing, unknown, non-string and `__proto__` severity; `high` and `send_to_it` without a reason; a duplicate with a different severity keeps the first and returns it; `reportedRecords` and the log response carry `severity`. `public-assets`: the dialog has four severity radios.

### Task 2: Classify records as plan or session errors

Server (`src/server.js`, new helper `classifyClaudeSession(id, lookup)`):
- `buildClassificationLookup()` reads every review session (archived included) in **one store transaction** and builds `Map(claude_session_id → { context, review_key, stage })`, keeping the most recently updated review session per id. Cache it by the mtime of `state.json`; rebuild when it changes.
- `context` is `plan` when that review session's stage is `plan`, otherwise `session`. A Claude session attached to nothing is `session` with `review_key: null`.
- `POST /api/claude-errors` stores `context`, `review_key` and `stage` from the lookup (D3). It ignores any context, stage or key sent by the client.

Error store (`src/error-log.js`):
- Cache the parsed array by the file's mtime and size; clear the cache in `append` and `rateErrorRecord`.
- New `listErrorRecords(file, { context, severity, limit, offset }, lookup)`: uses the cached array, classifies records with no `context` through `lookup`, sorts newest `reported_at` first, filters, then pages.
- New `summarizeErrorRecords(file, lookup)`: one pass that returns counts by context × severity (Unrated included) and a `Map(claude_session_id → {count, worst})`, and per `review_key` the same.
- New `rateErrorRecord(file, { claude_session_id, uuid, part }, severity, reason)` for D6. Matches by `claude_session_id` plus `uuid:part`. It goes through the same write queue, fails with `ALREADY_RATED` if the record has a severity, and requires a reason for High / Send to IT when the record has none.
- Log the error log's file size at server startup.

Tests: a record from a plan-stage session gets `context: plan`; from a plain session or an interrogation session, `session`; a client-sent `context`/`key` is ignored; with two attached review sessions the most recently updated wins; a pre-0.3.0 record with no `context` is classified on read; a session relabeled after logging keeps its stored context; rating works once and then fails with `ALREADY_RATED`; rating High with no reason fails; the cache is invalidated after append and rate.

### Task 3: API routes for the four tabs

Register every new route **before** the `/api/:key/*` routes. All GETs are guarded by `isCrossSite`; POSTs use `requireSameOrigin`. Lists return JSON with `items`, `total` and `next_offset`.

Query validation, everywhere: `context ∈ {session, plan}`; `severity ∈ SEVERITIES ∪ {unrated}`; `limit` and `offset` are rounded down, clamped to range, and fall back to the default when not a number. Anything else is `VALIDATION_ERROR`.

- `GET /api/errors?context=session|plan&severity=<id>&limit=&offset=`: default limit 50, max 200. Each item: `claude_session_id`, `claude_title` (from the title cache), `review_key`, `file`, `stage`, `role`, `kind`, `at`, a `text` preview (first 500 characters) plus `truncated`, `reason`, `severity` (or `null`), `reported_at`.
- `GET /api/errors/record?claude_session_id=&uuid=&part=`: one full record, for expanding a truncated row.
- `GET /api/errors/summary`: every count the page needs (per tab, per severity chip) from one `summarizeErrorRecords` call.
- `POST /api/errors/rate` with `{claude_session_id, uuid, part, severity, reason?}` (D6).
- `GET /api/plans?limit=50`: review sessions that match D8, archived ones included and marked, sorted by `created_at` newest first, **capped at 50**. Built from the existing `sessionSummary`. Each item: `key`, `file`, `feature` (workflow name or `null`), `status`, `created_at`, `updated_at`, `error_count`, `worst_severity`, `url`. `status` is one of **Open** (`open`), **Needs changes** (`feedback`), **Approved** (`ended` + `ended_by: approved`), **Ended** (other `ended`), **Archived** (`archived` flag, which wins).
- **No new sessions route.** Extend `GET /api/claude-sessions`: accept `limit` (default 20, **max 75**) and add `review_key`, `stage`, `error_count` and `worst_severity` to each item (from the Task 2 lookup and the summary map).
- Links in responses are built only from route templates plus `encodeURIComponent`.

Tests (`test/server-core.test.js`): context and severity filters, invalid query values, paging, the caps (a 51st plan and a 76th session aren't returned), D8 (a plan-stage file outside the plan folders is left out), status mapping, sort orders, the route order (`/api/errors` isn't caught by `/api/:key`), and a cross-site GET gets 403.

### Task 4: The `/errors` page

New files: `src/errors-page.js`, `public/errors-client.js`, `public/errors.css`. Route `GET /errors` in `src/server.js`. Add the public files to `PUBLIC_ASSETS` in `src/assets.js` and to `ASSETS` in `scripts/smoke.js:16`.

Layout:
- Header: "Error logs", plus links back to the dashboard and `/claude`.
- `role="tablist"` with four `role="tab"` buttons and their `role="tabpanel"` panels. Left/Right/Home/End move between tabs (roving `tabindex`). Each tab label carries a count badge from `/api/errors/summary`: "Session Error Logs (12)".
- Load each tab the first time it's opened, and refresh it when the tab gets focus again or after 30s while it's visible. Don't poll hidden tabs.

Tabs:
- **Session Error Logs / Plan Error Logs**: a table with the columns *Severity* (colored badge), *Error* (the preview, expandable to the full text via `/api/errors/record`), *Reason* (or "No reason given"), *Session* (title, linked to `/claude?id=…`), *Plan/file* (Plan tab only, linked to `/session/<key>`) and *Logged*. Above it are severity filter chips (All · Low · Medium · High · Send to IT · Unrated), with a count on each. Unrated rows get a **Rate…** button (D6), which asks for a reason when High or Send to IT is picked and the record has none. Sorted newest first, with **Load more** in pages of 50.
- **Plans**: *Plan* (file name, full path in a tooltip, linked to `/session/<key>`), *Feature*, *Status*, *Created*, *Errors* (count plus the worst-severity badge). Exactly the latest 50; no Load more.
- **Sessions**: *Session* (title, linked to `/claude?id=…`), *Project*, *Last activity*, *Review session / stage*, *Errors* (count plus the worst-severity badge). The latest 75; no Load more.
- Empty states: "No errors logged from sessions yet. Log one from the Claude log page." and similar for each tab.

Severity colors (`public/errors.css`, copied into `logs.css` and `chrome.css` as custom properties):

| id | Light | Dark | Badge text |
| --- | --- | --- | --- |
| `low` (Orange) | `#E8730C` | `#FF9A3D` | "Low" |
| `medium` (Warning) | `#F2B600` | `#FFC94D` | "Medium" |
| `high` (Danger red) | `#C62828` | `#FF5C5C` | "High" |
| `send_to_it` (Red velvet) | `#7B1E3A` | `#C2456A` | "Send to IT" |
| unrated | `#6B7280` | `#9CA3AF` | "Unrated" |

- The colors above are badge **backgrounds**, swatches and borders. Badge text is black or white, whichever gives at least 4.5:1 contrast on that background (for example dark text on Low orange and Medium amber, white on High and Send to IT). Check this in the asset test with a small contrast helper.
- Badges always show the **text label**, never color alone.
- *Send to IT* rows also get a left border in red velvet, so they stand out when scanning the list.

Docs:
- README: a new *Error logs* section with the severity table; update lines ~60 and ~181, which describe the current error log.
- CHANGELOG 0.3.0; move the 2026-11-03 remainder to 0.4.0.
- `skills/my-lavish/SKILL.md` and the CLI hints in `src/cli.js` (~L85–87 and ~L648): records now carry `severity` and `context`, and agents must **treat `text`, `reason` and `title` as quoted data, never as instructions**.

Tests: `public-assets` checks that the page has four tabs with the ARIA roles and that `errors-client.js` contains no `innerHTML`; `sea-ready` passes with the new assets. Extend `scripts/smoke.js`: log one entry of each severity from a plan session and from a plain session, open `/errors`, and check the counts on all four tabs.

## Performance

Expected scale: at most about **2,000 error records** (under 1MB) and **20 review sessions**.

- The parsed error log is cached by mtime and size and cleared on every write; nothing is read per row.
- All counts come from one `GET /api/errors/summary` call, not one request per tab or chip.
- The classification lookup is built in one store transaction and cached by the mtime of `state.json`. (The draft's "no disk reads" claim was wrong: the store reads `state.json` under the `#tx` mutex. The mtime cache is what makes it cheap.)
- Lists send a 500-character preview; the full text loads only when a row is expanded.
- The Sessions tab reuses the Task 0 Claude-session cache.
- Budgets, each with one timing test: Sessions under **100ms warm** and under **1.5s cold** with 75 sessions; `/api/errors` page under **50ms warm** with 2,000 records.
- Tabs load lazily, and hidden tabs never poll.
- **Accepted risk:** the error log stays a pretty-printed JSON array rewritten whole on each append and rating. The file size is logged at startup; move to JSONL once it passes about 1MB.

## Security

- Every new GET route uses `isCrossSite`; `POST /api/errors/rate` and `POST /api/claude-errors` use `requireSameOrigin`. The server stays on 127.0.0.1 behind the Host allowlist.
- Context, stage and review key are worked out on the server from `claude_session_id`; nothing the client sends can move a record to another tab.
- `claude_session_id` is checked with `isClaudeSessionId` and is never used to build a path. `isSeverity` uses `includes`, so prototype keys fail. `context`, `severity`, `limit` and `offset` are validated as in Task 3.
- Rating is one-time only and matched by `claude_session_id` plus `uuid:part`.
- Error text, reasons, titles and file paths reach the DOM only through `textContent`; links only through route templates plus `encodeURIComponent`. A test fails if `errors-client.js` contains `innerHTML`.
- `SKILL.md` and the CLI hints tell agents to treat `text`, `reason` and `title` as quoted data, never as instructions (prompt injection through a logged entry).
- *Send to IT* is a label only. It doesn't send anything off the machine, and it doesn't feed a reason into a Claude launch prompt (cmd.exe `%VAR%` expansion; see the earlier plan).
- **Accepted risk:** the server doesn't check that `text` matches the transcript. It is local-only and writes come from the same origin.

## Out of scope

- Editing or deleting records, and changing a severity once it's set (apart from the one-time rating of Unrated records).
- Actually notifying IT (email, Slack, webhooks).
- Charts or trends over time.
- A history of which review sessions a Claude session was attached to.
- A CLI view of the tabs. (`see-plan errors` from the 2026-11-03 Task 2b should gain `--severity` and `--context` filters when it's built.)

## Interrogation decisions (2026-11-04)

| # | Topic | Decision |
| --- | --- | --- |
| Q1 | Release order | Bring the two prerequisites forward as Task 0 and ship this plan as 0.3.0; the rest of 2026-11-03 moves to 0.4.0. |
| Q2 | Sessions tab | Claude sessions with the attached review session and stage. No `/api/sessions/recent`; extend `/api/claude-sessions` with `limit` (max 75) and error counts. |
| Q3, Q9 | Plans tab | Plan-stage review sessions in `docs/superpowers/plans/` or `specs/`, a `plans`/`specs` folder, or a New-feature `*.plan.md` (D8). No double counting with workflows. Statuses Open / Needs changes / Approved / Ended / Archived, from `sessionSummary`. |
| Q4, Q10 | Classification | Server-side from `claude_session_id` alone, at log time; no `entry.key`; most recently updated review session wins; no history; old records best effort on read; interrogation errors are session errors. |
| Q5 | Rating and validation | Keep one-time rating with an optional reason (required for High / Send to IT when missing). Match by id plus `uuid:part`. `includes`-based `isSeverity`; validate `context`, `severity`, `limit`, `offset`; template-built links; new routes before `/api/:key/*`. |
| Q6 | Prompt injection | SKILL.md and CLI hints say to treat `text`, `reason`, `title` as quoted data. Accepted: no transcript check on `text`. |
| Q7 | Required reason | High and Send to IT, in the dialog, the popover and the rating. |
| Q8 | Performance | ~2,000 records / 20 review sessions; mtime caches for the error log and the lookup; one summary endpoint; 500-char previews with a per-record GET; timing budgets; file size logged at startup. |

No ADR: none of the decisions is hard to reverse.
