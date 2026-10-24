# my-lavish-axi Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `my-lavish-axi`, an agent-run CLI plus local server that opens an agent-written HTML file in the browser, lets a human annotate it and chat, and returns that feedback to the agent through a long-poll.

**Architecture:** The CLI (`bin/my-lavish-axi.js` → `src/cli.js`) starts one detached Express + WebSocket server and reuses it via `/health`. Sessions are keyed by a hash of the HTML file's real path and stored in `state.json`. The browser "chrome" page frames the artifact in a sandboxed iframe; an injected SDK script turns clicks and selections into prompts and `postMessage`s them to the chrome, which POSTs them to the server; `my-lavish-axi poll` long-polls until they arrive.

**Tech Stack:** Node.js ≥ 22, ESM JavaScript (no TypeScript, no build step), `express@^5`, `ws@^8`, `chokidar@^4`, `open@^10`, `node:test` + `node:assert/strict`.

**Spec:** `docs/superpowers/specs/2026-10-24-my-lavish-axi-design.md`. Read it first: it explains the reference app and cites the code each mechanism comes from.

## Global Constraints

- Node `>=22` (`"engines"`), `"type": "module"`, runtime deps limited to `express`, `ws`, `chokidar`, `open`.
- No build step: `bin/my-lavish-axi.js` imports `src/cli.js` directly; browser files in `public/` are served as raw files.
- Must work on Windows (the dev machine is Windows 11): use `path`/`fs` APIs, never hardcoded `/`; spawn the server with `process.execPath`; use `windowsHide: true`.
- Default port `4388` (`MY_LAVISH_PORT`), state dir `~/.my-lavish-axi` (`MY_LAVISH_STATE_DIR`), `MY_LAVISH_NO_OPEN=1` = `--no-open`, idle timeout `MY_LAVISH_IDLE_TIMEOUT_MS` default `1800000`, `0`/`off` disables.
- Health response `app` field is exactly `"my-lavish-axi"`.
- Session key = first 16 hex chars of `sha256(realpath)`.
- The artifact route changes the HTML in exactly one way: it adds one `<script src="/sdk.js?key=<key>"></script>` before `</body>`, or at the end of the file if there is no `</body>`.
- Artifact iframe: `sandbox="allow-scripts allow-forms allow-popups"`, never `allow-same-origin`.
- Browser messages carry `source: "my-lavish"`; the chrome accepts only those whose `event.source === frame.contentWindow`, and the chrome (never the iframe) assigns each prompt's `prompt_id` (`crypto.randomUUID()`).
- Agent chat text renders as limited Markdown; user text is always HTML-escaped.
- CLI stdout is reserved for the final response (TOON by default, JSON with `--json`); progress goes to stderr. Every response carries a `next_step` string.
- Tests that start a server set `MY_LAVISH_STATE_DIR` to a fresh `fs.mkdtemp` dir and use port `0`.
- Commit after every task; message style `feat: …` / `test: …`; end each commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Same file, different spelling** (relative path, `..` segment, different letter case on Windows) must map to one session → test in Task 2 (`canonicalFile`) and Task 3 (`sessionKey` via `upsertSession`).
2. **Agent's poll gets killed mid-wait** (Ctrl+C, harness timeout): the next poll must not be refused with `LISTENER_ACTIVE`, and feedback taken by a poll whose client vanished must not be lost → tests in Task 6.
3. **Path traversal on assets** (`/artifact/<key>/../secret.txt`, `%2e%2e%2f`, a symlink pointing outside) must 404, never serve the file → test in Task 5.
4. **Cross-site POST to `/api/:key/prompts`** (foreign `Origin`) must 403, while header-less CLI requests to `/api/poll` keep working → tests in Task 5/6.
5. **Agent reply containing HTML** (`<img onerror=…>`, `<script>`) must render as text, and user notes are never parsed → test in Task 4.

---

## File Structure

```
my-lavish-axi/
  package.json, .gitignore, README.md
  bin/my-lavish-axi.js        # #!/usr/bin/env node → run(process.argv.slice(2))
  src/toon.js                 # toToon(value) compact agent output
  src/artifact-path.js        # canonicalFile, assertHtmlFile, resolveArtifactAsset
  src/async-mutex.js          # Mutex.runExclusive(fn)
  src/session-store.js        # SessionStore + sessionKey (state.json)
  src/html-transform.js       # injectSdk(html, key, revision)
  src/markdown.js             # escapeHtml, renderAgentMarkdown, serializeChat
  src/chrome-page.js          # createChromeHtml(session)
  src/server.js               # createServer(...) routes, poll, WebSocket, watcher, idle exit
  src/guidance.js             # DESIGN_TEXT, PLAYBOOKS, HOME_HELP
  src/cli.js                  # run(argv, io) + output builders + ensureServer
  public/chrome-client.js     # browser: conversation panel, queue, send, live events
  public/chrome.css
  public/sdk.js               # browser, injected into artifact: annotate, select, snapshot
  skills/my-lavish/SKILL.md   # stub that points at the CLI
  scripts/smoke.js            # end-to-end loop without a browser
  examples/plan.html          # sample artifact for manual review
  test/*.test.js
```

---

### Task 1: Project scaffold + TOON encoder

**Files:**
- Create: `package.json`, `.gitignore`, `src/toon.js`, `test/toon.test.js`

**Interfaces:**
- Produces: `toToon(value: object): string`

- [ ] **Step 1: Scaffold.** `git init`; `package.json` with `"name": "my-lavish-axi"`, `"version": "0.1.0"`, `"type": "module"`, `"bin": {"my-lavish-axi": "bin/my-lavish-axi.js"}`, `"engines": {"node": ">=22"}`, `"scripts": {"test": "node --test", "smoke": "node scripts/smoke.js"}`; `npm install express@^5 ws@^8 chokidar@^4 open@^10`. `.gitignore`: `node_modules/`, `*.log`.

- [ ] **Step 2: Write the failing test** `test/toon.test.js`:

```js
test("scalars, nesting, and quoting", () => {
  assert.equal(toToon({ a: 1, b: true, c: null, d: "plain" }), "a: 1\nb: true\nc: null\nd: plain");
  assert.equal(toToon({ s: { file: "C:\\x.html", status: "open" } }), 's:\n  file: "C:\\\\x.html"\n  status: open');
  assert.equal(toToon({ e: "", n: "line1\nline2", t: "true" }), 'e: ""\nn: "line1\\nline2"\nt: "true"');
});
test("arrays", () => {
  assert.equal(toToon({ ids: ["plan", "table"] }), "ids[2]: plan,table");
  assert.equal(toToon({ ids: [] }), "ids[0]:");
  assert.equal(
    toToon({ rows: [{ id: "plan", n: 1 }, { id: "a,b", n: 2 }] }),
    'rows[2]{id,n}:\n  plan,1\n  "a,b",2',
  );
  assert.equal(toToon({ mixed: [{ a: 1 }, { b: { c: 2 } }] }), "mixed[2]:\n  - a: 1\n  - b:\n      c: 2");
});
```

- [ ] **Step 3: Run** `node --test test/toon.test.js` → FAIL (module not found).

- [ ] **Step 4: Implement `toToon` in `src/toon.js`.** Rules: a string is emitted bare unless it is empty, matches `/^(true|false|null|-?\d)/`, has leading/trailing whitespace, or contains any of `: , " \n \r \t [ ] { } #` or `\`. Otherwise `JSON.stringify` it. Arrays of primitives go inline. Arrays of objects that all have the same primitive-only keys use the tabular `key[N]{k1,k2}:` form. Any other array uses the `- ` list form, with nested lines indented to line up after `- `. Indent is 2 spaces.

- [ ] **Step 5: Run** `node --test` → PASS. **Commit** `feat: scaffold project and TOON encoder`.

---

### Task 2: Artifact paths

**Files:**
- Create: `src/artifact-path.js`, `test/artifact-path.test.js`

**Interfaces:**
- Produces:
  - `canonicalFile(file: string): Promise<string>` — `path.resolve` then `fs.promises.realpath`.
  - `assertHtmlFile(file: string): Promise<void>` — throws `Error` with `code = "VALIDATION_ERROR"` unless it is a regular file ending `.html`/`.htm` (case-insensitive) after realpath. Message for a missing file: `File not found: <file>`.
  - `resolveArtifactAsset(rootDir: string, relPath: string): Promise<string | null>` — returns the real absolute path when it stays inside `rootDir` (lexically and after realpath), else `null`. A path that does not exist returns `null`.

- [ ] **Step 1: Write failing tests** (use a `fs.mkdtemp` tree with `site/a.html`, `site/img/x.png`, `secret.txt` beside `site/`):
  - `canonicalFile(join(dir,"site","..","site","a.html"))` equals `canonicalFile(join(dir,"site","a.html"))`; on `process.platform === "win32"` also the upper-cased path gives the same result.
  - `assertHtmlFile` rejects `secret.txt` and a missing file (`code === "VALIDATION_ERROR"`), accepts `A.HTM`.
  - `resolveArtifactAsset(site, "img/x.png")` returns the real path; `"../secret.txt"`, `"..%2fsecret.txt"` decoded to `"../secret.txt"`, and `"nope.png"` return `null`.
  - A symlink `site/link.txt → ../secret.txt` returns `null` (skip the test with `t.skip()` if `symlink` throws `EPERM` on Windows).

- [ ] **Step 2: Run** `node --test test/artifact-path.test.js` → FAIL.
- [ ] **Step 3: Implement** the three functions. For the containment check, compare `path.relative(realRoot, realTarget)`: reject if it starts with `..` or is absolute.
- [ ] **Step 4: Run** → PASS. **Commit** `feat: artifact path canonicalization and confinement`.

---

### Task 3: Session store

**Files:**
- Create: `src/async-mutex.js`, `src/session-store.js`, `test/session-store.test.js`

**Interfaces:**
- Consumes: nothing (the caller passes canonical paths).
- Produces:
  - `class Mutex { runExclusive<T>(fn: () => Promise<T>): Promise<T> }` (promise chain; a rejected fn must not block the next one).
  - `sessionKey(file: string): string` — `sha256(file)` hex, first 16 chars.
  - `class StoreError extends Error { code: "MISSING" | "ENDED" }`
  - `new SessionStore(stateDir: string)`, all methods async and serialized through one `Mutex`:
    - `upsertSession(file, baseUrl, { reopen = false } = {}) → { status: "opened" | "resumed" | "user-ended", session }`. New session → `"opened"`. Existing session → `"resumed"`, and if it was ended by the agent it becomes `status: "open"` again. Existing session ended by `"user"` without `reopen` → `"user-ended"`, unchanged.
    - `getSession(key) → Session | null`, `listSessions() → Session[]`
    - `queuePrompts(key, { prompts, dom_snapshot = "", end = false }, { restore = false } = {}) → { accepted: number }` — throws `StoreError("MISSING")` / `StoreError("ENDED")` (ENDED is skipped when `restore`). Skips prompts whose `prompt_id` already exists in `chat` (idempotent retry). Non-restore: appends one `chat` entry `{ role: "user", text: prompt.prompt, anchor, at, prompt_id }` per accepted prompt (`anchor` = `"text selection"` for `tag === "text"`, `""` for `tag === "chat"`, else `<tag> <selector>`). Restore: prepends prompts and adds no chat. Sets `status: "feedback"` when anything is accepted. `end: true` ends the session with `ended_by: "user"` in the same write.
    - `takeFeedback(key) → { status: "missing" } | { status: "waiting" } | { status: "ended", ended_by } | { status: "feedback", prompts, dom_snapshot, session_ended?: true, ended_by? }` — drains `prompts` and `dom_snapshot`. Prompts queued before an end are still delivered (with `session_ended: true`), and the next take returns `"ended"`.
    - `appendAgentReply(key, text) → ChatEntry` (`{ role: "agent", text, at }`)
    - `endSession(key, endedBy: "user" | "agent") → Session`
    - `bumpRevision(key) → number`
  - `Session = { key, file, dir, url, status: "open" | "feedback" | "ended", ended_by?, prompts: Prompt[], dom_snapshot, chat: ChatEntry[], revision, created_at, updated_at }`
  - `Prompt = { prompt_id, prompt, tag, selector, text, target? }`
  - Persistence: `<stateDir>/state.json` as `{ version: 1, sessions: { [key]: Session } }`, written to a temp file and then renamed. A missing or unparseable file reads as empty.

- [ ] **Step 1: Write failing tests:**
  - `sessionKey("C:\\a.html")` matches `/^[0-9a-f]{16}$/` and is stable.
  - upsert twice → `"opened"` then `"resumed"`, same `key`; `session.url === baseUrl + "/session/" + key`.
  - queue 2 prompts → `{accepted: 2}`; take → `feedback` with both in order, `dom_snapshot` kept; take again → `waiting`.
  - re-queue the same `prompt_id` → `{accepted: 0}`, chat length unchanged.
  - `queuePrompts(..., {end: true})` → take gives `feedback` + `session_ended: true, ended_by: "user"`; next take → `{status: "ended", ended_by: "user"}`; queuing again throws `code === "ENDED"`.
  - user-ended → upsert gives `"user-ended"`; with `{reopen: true}` → `"resumed"` and `status === "open"`. Agent-ended → plain upsert reopens.
  - restore after take prepends: queue A, take, queue B, restore [A] → take returns [A, B].
  - a new `SessionStore` on the same dir sees the saved sessions; a corrupt `state.json` reads as no sessions.
  - 20 concurrent `queuePrompts` calls → total accepted 20, no lost write.
- [ ] **Step 2: Run** `node --test test/session-store.test.js` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS. **Commit** `feat: session store keyed by artifact path`.

---

### Task 4: SDK injection + chat rendering

**Files:**
- Create: `src/html-transform.js`, `src/markdown.js`, `test/html-transform.test.js`, `test/markdown.test.js`

**Interfaces:**
- Produces:
  - `injectSdk(html: string, key: string, revision: number): string` — script tag `<script src="/sdk.js?key=${encodeURIComponent(key)}&rev=${revision}"></script>` inserted before the last `</body>` (case-insensitive), or appended after a `\n`.
  - `escapeHtml(s: string): string` (`& < > " '`)
  - `renderAgentMarkdown(text: string): string` — escape first, then: blank-line paragraphs `<p>`, single newlines `<br>`, `- `/`* ` → `<ul><li>`, `1. ` → `<ol><li>`, `## x` → `<p><strong>x</strong></p>`, fenced ``` → `<pre><code>`, `` `x` `` → `<code>`, `**x**` → `<strong>`, `*x*` → `<em>`, `[t](http(s)://…)` → `<a href target="_blank" rel="noopener">`. No other links (e.g. `javascript:`) become anchors.
  - `serializeChat(chat: ChatEntry[]): Array<{ role: "user", text, anchor, at, prompt_id } | { role: "agent", html, at }>`

- [ ] **Step 1: Write failing tests:**
  - `injectSdk("<html><body><p>x</p></body></html>", "abc", 3)` equals `'<html><body><p>x</p><script src="/sdk.js?key=abc&rev=3"></script></body></html>'`; `injectSdk("<p>x</p>", "abc", 0)` ends with `'\n<script src="/sdk.js?key=abc&rev=0"></script>'`; the rest of the input is unchanged.
  - `renderAgentMarkdown("Hi **there**\n\n- a\n- b")` === `"<p>Hi <strong>there</strong></p><ul><li>a</li><li>b</li></ul>"`.
  - `renderAgentMarkdown('<img src=x onerror=alert(1)>')` contains `&lt;img` and no `<img`; `[x](javascript:alert(1))` contains no `<a`.
  - `serializeChat([{role:"user", text:"<b>hi</b>", …}])[0]` has `text === "<b>hi</b>"` and no `html` key (the client escapes it); agent entries have `html` and no `text`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat: SDK injection and agent markdown rendering`.

---

### Task 5: Server core — health, sessions, chrome page, artifact routes, guards

**Files:**
- Create: `src/server.js`, `src/chrome-page.js`, `public/chrome-client.js` (stub: `// filled in Task 7`), `public/chrome.css` (stub), `public/sdk.js` (stub), `test/server-core.test.js`

**Interfaces:**
- Consumes: `SessionStore`, `sessionKey` (Task 3); `assertHtmlFile`, `canonicalFile`, `resolveArtifactAsset` (Task 2); `injectSdk` (Task 4).
- Produces:
  - `createServer({ store, stateDir, port = 4388, host = "127.0.0.1", idleTimeoutMs = 1800000, version, log = () => {} }) → { app, events: EventEmitter, listen(): Promise<{ port: number, baseUrl: string }>, close(): Promise<void> }`. `baseUrl` = `http://127.0.0.1:<port>`. Sets `httpServer.requestTimeout = 0` and `httpServer.timeout = 0` so long polls are never cut off.
  - `createChromeHtml(session, { baseUrl }): string` — includes `<iframe id="artifact" sandbox="allow-scripts allow-forms allow-popups" src="/artifact/<key>/index.html?rev=<revision>">`, a `<script type="application/json" id="my-lavish-session">` with `{ key, file, status, ended_by, chat: serializeChat(...) }` (escape `<` as `\u003c` inside it), the panel markup (`#chatLog`, `#queuedLog`, `#chatInput`, `#send`, `#sendAndEnd`, `#endSession`, `#presenceBanner`, `#annotateToggle`), `<link rel="stylesheet" href="/chrome.css">`, `<script src="/chrome-client.js">`. The page `<title>` is the artifact's `<title>` when present, else `my-lavish-axi`.
  - Routes in this task:
    - Global middleware 1: **Host allowlist.** Allow `Host` hostnames `127.0.0.1`, `localhost`, `[::1]`. Anything else → `403 {error:{code:"FORBIDDEN_HOST"}}`.
    - Global middleware 2: **Origin guard.** For non-GET/HEAD requests with an `Origin` (or else `Referer`) header whose origin is not `http://<Host>` → `403 {error:{code:"FORBIDDEN_ORIGIN"}}`. Requests with no Origin/Referer pass.
    - Helper `requireSameOrigin(req)`: true only when `Origin` is present and matches. Used by browser-only routes (`/api/:key/prompts`, `/api/:key/end`) so the key alone can never queue feedback.
    - `GET /health` → `{ ok: true, app: "my-lavish-axi", version, state_dir }`
    - `POST /shutdown` → `{ ok: true }` then close
    - `POST /api/sessions` `{ file, reopen }` → validates with `assertHtmlFile` (400 `{error:{code:"VALIDATION_ERROR", message}}`), upserts, starts watching the file (Task 6), returns `{ status, key, url }`
    - `GET /session/:key` → chrome HTML with `X-Frame-Options: DENY` and `Content-Security-Policy: frame-ancestors 'none'`; unknown key → 404
    - `GET /artifact/:key/index.html` → `injectSdk(fileContents, key, revision)` with header `Content-Security-Policy: sandbox allow-scripts allow-forms allow-popups`
    - `GET /artifact/:key/*` → `resolveArtifactAsset(session.dir, decodedPath)` → `sendFile` (with `dotfiles: "allow"`) or 404
    - `GET /sdk.js`, `/chrome-client.js`, `/chrome.css` → files from `public/` with `Cache-Control: no-cache`

- [ ] **Step 1: Write failing tests** (start with `createServer({store: new SessionStore(tmp), stateDir: tmp, port: 0, version: "0.1.0"})`, use `fetch`):
  - `/health` → `app === "my-lavish-axi"`.
  - `fetch(base + "/health", { headers: { Host: "evil.example" } })` → 403. Note: `fetch` does not let you override `Host`, so use `node:http.request` with an explicit `host` header for this test.
  - `POST /api/sessions` with a `.txt` file → 400; with `a.html` → `{status:"opened", key, url}`.
  - `GET /session/<key>` → 200, has `X-Frame-Options: DENY`, body contains `sandbox="allow-scripts allow-forms allow-popups"` and not `allow-same-origin`.
  - `GET /artifact/<key>/index.html` body === original file + the one script tag (compare with `injectSdk(original, key, 0)`).
  - `GET /artifact/<key>/img/x.png` → 200; `/artifact/<key>/..%2f..%2fsecret.txt` and `/artifact/<key>/%2e%2e/secret.txt` → 404.
  - `POST /api/sessions` with `Origin: http://evil.example` → 403; with no Origin → 200.
- [ ] **Step 2: Run** `node --test test/server-core.test.js` → FAIL.
- [ ] **Step 3: Implement** `src/chrome-page.js` and the routes above in `src/server.js`.
- [ ] **Step 4: Run** → PASS. **Commit** `feat: server core with sandboxed artifact serving`.

---

### Task 6: Server feedback loop — prompts, poll, reply, end, live events, watcher, idle exit

**Files:**
- Modify: `src/server.js`
- Test: `test/server-loop.test.js`

**Interfaces:**
- Consumes: Task 3 store methods, Task 4 `serializeChat`, Task 5 `createServer`/`requireSameOrigin`.
- Produces (HTTP contract used by the CLI in Task 8 and the browser in Task 7):
  - `POST /api/:key/prompts` `{ prompts: Prompt[], dom_snapshot?, end? }` → requires same origin (else 403). → `{ accepted, chat: serializeChat(...) }`. `StoreError` ENDED → 409 `{error:{code:"ENDED"}}`, MISSING → 404. After it accepts, emits `feedback` (when `accepted > 0`) and broadcasts `chat`. With `end`, it emits `ended` and broadcasts `ended`.
  - `GET /api/poll?file=<abs>&timeoutMs=<n>` and `POST /api/poll` `{ file, agent_reply?, timeoutMs? }` → resolve key with `sessionKey(await canonicalFile(file))`. Unknown → 404 `{status:"missing"}`. One listener per key in a `Map` `activePolls`; a second one → 409 `{error:{code:"LISTENER_ACTIVE"}}`. POST with `agent_reply` first calls `appendAgentReply` and broadcasts `chat`. Then `takeFeedback`: non-waiting → respond right away. Waiting → mark the key listening (broadcast `{type:"presence", listening:true}`), wait for an `events` `feedback`/`ended` event for this key or the timeout, then take again and respond. **If the request socket closes before the response is written** (`res.on("close")` with `!res.writableFinished`), call `queuePrompts(key, result, {restore: true})` when a `feedback` result was taken, re-emit `feedback`, and always remove the listener and broadcast `listening:false`.
  - `POST /api/:key/agent-reply` `{ text }` (header-less allowed) → empty/whitespace text → 400; else `{ ok: true }` and broadcasts `chat`.
  - `POST /api/:key/end` `{ ended_by }` — browser calls (same origin) record `"user"`; header-less CLI calls record `"agent"`. Emits `ended`, broadcasts `{type:"ended", ended_by}`.
  - WebSocket at `/events/:key` (`ws` `WebSocketServer({ noServer: true })` on `upgrade`; apply the same Host allowlist there). On connect, send `{type:"presence", listening}` and `{type:"chat", chat}`. Ping every 30 s; terminate sockets that missed a pong. Messages: `{type:"chat", chat}`, `{type:"presence", listening}`, `{type:"reload", revision}`, `{type:"ended", ended_by}`.
  - File watcher: one `chokidar.watch(file, { ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 } })` per session. On `change`/`add`: `bumpRevision` → broadcast `{type:"reload", revision}`. Watchers close in `close()`.
  - Idle exit: when there are 0 WebSockets and 0 active polls for `idleTimeoutMs` (ignored when `0`), call `close()` and then `process.exit(0)` only when `createServer` was called with `exitOnIdle: true` (the `server` CLI command passes it; tests do not).

- [ ] **Step 1: Write failing tests** (helper `postPrompts(key, body)` sends `Origin: base`):
  - prompts without Origin → 403; with Origin → `{accepted: 1}` and `chat[0].text` is the note.
  - queued before poll: `GET /api/poll?file=…&timeoutMs=2000` returns at once with `status:"feedback"`.
  - waiting poll: start poll (`timeoutMs=5000`), after 100 ms post prompts → poll resolves with the prompt in under 1 s.
  - timeout: `timeoutMs=200` with nothing queued → `{status:"waiting"}`.
  - second concurrent poll → 409 `LISTENER_ACTIVE`.
  - **killed poll:** start a poll with an `AbortController`, abort after 100 ms, then post a prompt; a new poll with `timeoutMs=2000` returns that prompt (no 409).
  - `POST /api/poll {file, agent_reply: "Done **ok**"}` with `timeoutMs: 200` → the chat on the next `/session/<key>` bootstrap JSON includes an agent entry whose `html` contains `<strong>ok</strong>`.
  - browser end (`/api/:key/end` with Origin) → poll returns `{status:"ended", ended_by:"user"}`; posting prompts afterwards → 409.
  - WebSocket: connect `ws://127.0.0.1:<port>/events/<key>`, `writeFile` the HTML, receive `{type:"reload", revision: 1}` within 3 s.
- [ ] **Step 2: Run** `node --test test/server-loop.test.js` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `node --test` (whole suite) → PASS. **Commit** `feat: long-poll feedback loop and live events`.

---

### Task 7: Browser — injected SDK and chrome client

**Files:**
- Modify: `public/sdk.js`, `public/chrome-client.js`, `public/chrome.css`
- Create: `test/public-assets.test.js`

**Interfaces:**
- Consumes: HTTP + WebSocket contract from Task 6; bootstrap JSON `#my-lavish-session` from Task 5.
- Produces — the `postMessage` protocol (every message has `source: "my-lavish"`):
  - SDK → chrome: `{type:"queuePrompt", prompt:{prompt, tag, selector, text, target?}}`, `{type:"snapshot", id, html}`, `{type:"scroll", x, y}`, `{type:"mode", annotate: boolean}`, `{type:"ready"}`
  - chrome → SDK: `{type:"requestSnapshot", id}`, `{type:"setMode", annotate}`, `{type:"restoreScroll", x, y}`
  - `window.lavish = { queuePrompt(text: string, options?: { element?, data? }), setAnnotate(on: boolean) }` inside the artifact (the name `window.lavish` is kept so artifacts written for the reference app still work).

**`public/sdk.js` (an IIFE, no imports) must:**
- Start in annotate mode unless `<html data-lavish-annotate="off">`.
- In annotate mode: outline the hovered element (`outline: 2px solid #c8963e` set as an inline style, saved and restored on leave). On click (capture phase, `preventDefault`), open a fixed-position note card with a textarea, **Queue** and **Cancel**. Enter = Queue, Shift+Enter = newline, Escape = Cancel only when empty.
- Ignore clicks inside native controls (`input, textarea, select, button, label, summary, [contenteditable]`), `[role=button|checkbox|radio|tab|switch|option|menuitem]`, `[data-lavish-action]`, and the card itself.
- On `mouseup` with a non-empty selection, show a small **Comment** button near the selection; its card queues `tag: "text"`, `text: selected text`, `target: {type:"text-range", text, selector: cssSelector(commonAncestor)}`.
- `cssSelector(el)`: `#id` when the id is unique, else a `tag:nth-of-type(n)` path joined with ` > ` up to `body`.
- Element prompt: `tag = el.tagName.toLowerCase()`, `selector = cssSelector(el)`, `text = el.innerText.trim().slice(0, 300)`.
- Ctrl+I / Cmd+I (capture phase) toggles annotate mode and posts `{type:"mode"}`.
- Post `scroll` (throttled to 200 ms) and `ready` on load. Answer `requestSnapshot` with `document.documentElement.outerHTML`, with the SDK `<script>` removed and the result cut to 200000 chars.

**`public/chrome-client.js` must:**
- Read bootstrap JSON; render chat (user entries via `textContent` only; agent entries via `innerHTML = entry.html`).
- Accept `message` events only when `event.source === frame.contentWindow && data.source === "my-lavish"`.
- On `queuePrompt`: add `prompt_id = crypto.randomUUID()`, push to a queue persisted in `sessionStorage` key `my-lavish:queue:<key>`, render it in `#queuedLog` as a dashed bubble with a remove (×) button.
- Composer: Enter sends, Shift+Enter newline. Typed text becomes a prompt `{tag:"chat", selector:"", text:"", prompt}`.
- **Send to Agent**: request a snapshot (wait at most 5000 ms), `POST /api/<key>/prompts` with `{prompts: queue, dom_snapshot}`. Remove queued items only when their `prompt_id` shows up in the returned `chat`. On failure keep the queue and show the error in `#sendHint`.
- **Send & End** = the same with `end: true`; **End session** button → `POST /api/<key>/end`.
- WebSocket `/events/<key>`: `chat` → re-render; `presence` → show `#presenceBanner` ("Your agent is not listening. Ask it to run my-lavish-axi poll.") when `listening` is false; `reload` → remember the last scroll, set `frame.src = "/artifact/<key>/index.html?rev=<revision>"`, and send `restoreScroll` after `ready`; `ended` → disable composer and buttons and show "Session ended". Reconnect with backoff of 1 s, 2 s, 5 s, then every 5 s.
- `#annotateToggle` button and Ctrl/Cmd+I in the chrome send `setMode`.

**`public/chrome.css`:** two-column layout (artifact iframe fills the left; 360 px Conversation panel on the right with scrollable log and sticky composer); below 860 px wide, stack the panel under the iframe. Define light/dark color tokens on `:root` using `prefers-color-scheme`.

- [ ] **Step 1: Write failing test** `test/public-assets.test.js`: for each of the three files, the server serves it with status 200. Both JS files pass `new Function(source)` without a syntax error. `sdk.js` contains `"my-lavish"` and `requestSnapshot`. `chrome-client.js` contains `event.source` and `randomUUID`.
- [ ] **Step 2: Run** → FAIL (stubs lack those strings).
- [ ] **Step 3: Implement** the three files.
- [ ] **Step 4: Run** `node --test` → PASS. **Commit** `feat: browser annotation SDK and conversation chrome`.

(This task is verified in a real browser in Task 9.)

---

### Task 8: CLI + guidance

**Files:**
- Create: `src/guidance.js`, `src/cli.js`, `bin/my-lavish-axi.js`, `test/cli.test.js`

**Interfaces:**
- Consumes: `toToon` (1), `canonicalFile`/`assertHtmlFile` (2), `SessionStore`/`sessionKey` (3), `createServer` (5/6).
- Produces:
  - `src/guidance.js`: `DESIGN_TEXT: string`; `PLAYBOOKS: Array<{ id, use_when, guidance }>` with ids exactly `plan`, `diagram`, `table`, `comparison`, `input`; `HOME_USAGE: string`.
    - `DESIGN_TEXT` must say: give the page an explicit background color; define colors as CSS custom properties with a dark-mode override; put sibling assets next to the HTML and use relative paths; prefer inline SVG for diagrams; use `window.lavish.queuePrompt()` for decision buttons and mark custom clickables with `data-lavish-action`.
    - Each playbook's `guidance` is 5–12 short lines (for example `plan` → goal, steps, risks, open questions as `data-lavish-question` blocks; `input` → radio/checkbox questions plus one **Submit** that calls `window.lavish.queuePrompt(JSON answer)`).
  - `src/cli.js`:
    - `run(argv: string[], io = { stdout: process.stdout, stderr: process.stderr, env: process.env }): Promise<number>` (exit code). Global flag `--json` switches output to `JSON.stringify(obj, null, 2)`. Errors print `{ error: { code, message }, next_step }` and return `1`.
    - Command dispatch: no args → home; `open <file>` or a bare `<file>` ending `.html`/`.htm` → open; `poll`, `reply`, `end`, `stop`, `design`, `playbook [id]`, `server`; `--help`/`-h` → home usage; `--version` → version string only.
    - `ensureServer(env) → Promise<string /* baseUrl */>`: probe `http://127.0.0.1:<port>/health` with `node:http` (1000 ms timeout, destroy the socket on every path). If `app === "my-lavish-axi"` reuse it. If nothing answers, spawn `process.execPath [bin/my-lavish-axi.js, "server"]` with `{ detached: true, stdio: ["ignore", logFd, logFd], windowsHide: true, env }` where `logFd` is opened in append mode on `<stateDir>/server.log`, then `child.unref()` and probe every 100 ms for up to 5000 ms. If a different app answers on the port → error `PORT_IN_USE`.
    - Pure output builders (tested directly):
      - `createOpenOutput({ file, url, status }) → { session: { file, url, status }, next_step }` — next_step: `Do not respond to the user yet. Run \`my-lavish-axi poll <file>\` now and leave it running; it stays silent until the user sends feedback or ends the session. After applying feedback, run \`my-lavish-axi poll <file> --agent-reply "<short summary>"\`.`
      - `createUserEndedOutput({ file })` — status `user-ended`, next_step says the user ended the session, give updates in chat, and use `--reopen` only if the user asks.
      - `createPollOutput({ file, response })` — key order **`session`, `prompts`, `next_step`, `dom_snapshot`**. For `feedback`: next_step tells the agent to apply each prompt (`selector` says where), edit the HTML file in place, then poll again with `--agent-reply`. When `session_ended`, it instead says to apply the changes, report in chat, and not poll again. `ended` → stop polling, do not reopen uninvited. `waiting` → re-run poll without `--timeout-ms`.
      - `createHomeOutput({ sessions }) → { sessions: [{file, status, url}], usage: HOME_USAGE, next_step }`
    - Commands:
      - open: `assertHtmlFile` → `canonicalFile` → `ensureServer` → `POST /api/sessions` → unless `--no-open`/`MY_LAVISH_NO_OPEN=1`, `await (await import("open")).default(url)` (on failure, report `status: "ready"`) → print the open output.
      - poll: `--agent-reply <text>` or `--agent-reply-file <path|->` (stdin when `-`; both together → `VALIDATION_ERROR`), `--timeout-ms <n>`. Write `Waiting for feedback on <file> (stays silent until the user sends)…` to stderr. Send `POST /api/poll` with `node:http` and **no timeout**. On SIGINT print `Poll interrupted. Feedback stays queued; re-run the same poll.` to stderr and exit 130.
      - reply: requires `--agent-reply`/`--agent-reply-file`; `POST /api/:key/agent-reply` with a 10000 ms timeout; output `{ ok: true, next_step }`.
      - end: `POST /api/:key/end` with no Origin (→ ended_by agent).
      - stop: `POST /shutdown` when health shows our app.
      - server: `createServer({..., exitOnIdle: true}).listen()`, log `listening on <baseUrl>` to stderr.
      - design / playbook: `{ design: DESIGN_TEXT, next_step }`; `playbook` with no id → `{ playbooks: PLAYBOOKS.map(({id,use_when}) => ({id,use_when})), next_step: "Open every playbook whose use_when matches before writing HTML: my-lavish-axi playbook <id>" }`; unknown id → `NOT_FOUND` error.
  - `bin/my-lavish-axi.js`: `#!/usr/bin/env node` + `process.exitCode = await run(process.argv.slice(2))`.

- [ ] **Step 1: Write failing tests** `test/cli.test.js`:
  - `Object.keys(createPollOutput({file:"f", response:{status:"feedback", prompts:[{prompt:"x"}], dom_snapshot:"<html>"}}))` deep-equals `["session","prompts","next_step","dom_snapshot"]`.
  - session_ended feedback → next_step does not contain `poll f` but does mention chat; `ended` → next_step contains `do not reopen` (case-insensitive).
  - `run(["playbook"], fakeIo)` returns 0 and stdout contains `playbooks[5]{id,use_when}:`; `run(["playbook","nope"])` returns 1 with `NOT_FOUND`.
  - `run(["open","missing.html"])` returns 1 with `VALIDATION_ERROR`.
  - Integration (env `MY_LAVISH_STATE_DIR=tmp`, `MY_LAVISH_PORT=` a free port from `net.createServer().listen(0)`, `MY_LAVISH_NO_OPEN=1`): `run(["open", file, "--json"])` → `session.status === "opened"`. Then `run(["poll", file, "--timeout-ms", "300", "--json"])` → `session.status === "waiting"`. Then `run(["stop"])` → 0. Use `t.after` to always stop the spawned server.
- [ ] **Step 2: Run** `node --test test/cli.test.js` → FAIL.
- [ ] **Step 3: Implement** `guidance.js`, `cli.js`, `bin/my-lavish-axi.js`.
- [ ] **Step 4: Run** `node --test` → PASS. **Commit** `feat: agent-facing CLI with TOON output and guidance`.

---

### Task 9: Skill, README, smoke script, and real-browser verification

**Files:**
- Create: `skills/my-lavish/SKILL.md`, `README.md`, `scripts/smoke.js`, `examples/plan.html`

**Interfaces:**
- Consumes: the whole CLI (Task 8) and the HTTP contract (Task 6).

- [ ] **Step 1: Skill stub** `skills/my-lavish/SKILL.md`, with frontmatter `name: my-lavish` and a `description:` saying when to use it (a plan, comparison, diagram, table, or report that is easier to grasp as a page). The body just says to run `npx my-lavish-axi --help`, `design`, and `playbook <id>` for current instructions, then write the HTML and run `my-lavish-axi <file>`. Do not copy CLI guidance into it.
- [ ] **Step 2: `examples/plan.html`** — a self-contained plan page (explicit background, CSS color tokens, inline SVG flow diagram, one `input`-style question with a Submit button that calls `window.lavish.queuePrompt`).
- [ ] **Step 3: `scripts/smoke.js`** — uses a temp state dir and a free port. Copies `examples/plan.html` to a temp dir, then runs `node bin/my-lavish-axi.js open <file> --no-open --json` (via `execFile`). Starts `poll <file> --json` in the background, then `POST /api/<key>/prompts` with `Origin: <baseUrl>` and one prompt `{prompt_id:"smoke-1", prompt:"Make the title bigger", tag:"h1", selector:"h1", text:"Plan"}`. Asserts the poll stdout's `prompts[0].prompt`, runs `reply <file> --agent-reply "Done"`, runs `end`, runs `stop`, and prints `SMOKE OK`. It exits 1 on any failure.
- [ ] **Step 4: Run** `npm run smoke` → prints `SMOKE OK`.
- [ ] **Step 5: Browser verification** (use the Playwright MCP tools if they are available, otherwise ask the user to click through). Run `node bin/my-lavish-axi.js examples/plan.html --no-open`, then open the printed URL. Check each of these:
  1. The artifact renders in the iframe and the Conversation panel shows.
  2. Clicking the `<h1>` opens a note card. Typing "bigger" + Enter adds a dashed **Queued** bubble.
  3. Selecting a sentence shows **Comment**, and queuing it adds a second bubble.
  4. In a terminal run `node bin/my-lavish-axi.js poll examples/plan.html --json`. The banner disappears (agent listening). Click **Send to Agent**: poll prints both prompts with selectors, and the bubbles turn into sent bubbles.
  5. Edit `examples/plan.html` (change the title text): the iframe reloads and keeps the scroll position.
  6. `poll … --agent-reply "Made it **bigger**" --timeout-ms 500` → the agent bubble shows bold text.
  7. Click **Send & End** → the page becomes read-only. A plain `node bin/my-lavish-axi.js examples/plan.html --no-open` returns `user-ended`.
  Save screenshots for 2, 4 and 7 to `docs/evidence/`.
- [ ] **Step 6: README.md** — what it is, quick start (`npm install`, `npm link`, `my-lavish-axi examples/plan.html`), how it works (an ASCII diagram of the loop: agent writes HTML → `my-lavish-axi <file>` opens browser → human annotates and sends → `poll` returns prompts → agent edits and replies), CLI reference table, env vars table, and a "Differences from lavish-axi" section listing the out-of-scope features from the spec.
- [ ] **Step 7: Run** `node --test && npm run smoke` → all PASS + `SMOKE OK`. **Commit** `docs: skill stub, README, smoke test, browser evidence`.
