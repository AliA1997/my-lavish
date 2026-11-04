import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "../src/server.js";
import { SessionStore } from "../src/session-store.js";
import { createChromeHtml } from "../src/chrome-page.js";

async function setup(t) {
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "mla-pub-"));
  const stateDir = path.join(tmp, "state");
  const srv = createServer({ store: new SessionStore(stateDir), stateDir, port: 0, version: "0.1.0" });
  const { baseUrl } = await srv.listen();
  t.after(async () => {
    await srv.close();
    await fs.promises.rm(tmp, { recursive: true, force: true });
  });
  return { baseUrl };
}

async function fetchAsset(baseUrl, name) {
  const res = await fetch(`${baseUrl}/${name}`);
  assert.equal(res.status, 200, `${name} status`);
  return res.text();
}

test("server serves every browser file", async (t) => {
  const { baseUrl } = await setup(t);
  for (const name of ["sdk.js", "chrome-client.js", "chrome.css", "logs-client.js", "logs.css", "home-client.js", "home.css", "errors-client.js", "errors.css"]) {
    await fetchAsset(baseUrl, name);
  }
});

test("browser scripts parse as classic scripts", async (t) => {
  const { baseUrl } = await setup(t);
  for (const name of ["sdk.js", "chrome-client.js", "home-client.js", "logs-client.js", "errors-client.js"]) {
    const source = await fetchAsset(baseUrl, name);
    assert.doesNotThrow(() => new Function(source), `${name} has a syntax error`);
  }
});

test("sdk.js speaks the my-lavish message protocol", async (t) => {
  const { baseUrl } = await setup(t);
  const source = await fetchAsset(baseUrl, "sdk.js");
  assert.ok(source.includes('"my-lavish"'), "sdk.js tags messages with source \"my-lavish\"");
  assert.ok(source.includes("requestSnapshot"), "sdk.js answers requestSnapshot");
});

test("chrome-client.js checks the sender and assigns prompt ids", async (t) => {
  const { baseUrl } = await setup(t);
  const source = await fetchAsset(baseUrl, "chrome-client.js");
  assert.ok(source.includes("event.source"), "chrome-client.js checks event.source");
  assert.ok(source.includes("randomUUID"), "chrome-client.js assigns prompt_id with randomUUID");
});

test("new session button is on the page and wired in the client", async (t) => {
  const { baseUrl } = await setup(t);
  const html = createChromeHtml({ key: "k", file: "f.html", status: "ended", chat: [], revision: 0 }, { baseUrl });
  assert.ok(html.includes('id="newSession"'));
  assert.ok((await fetchAsset(baseUrl, "chrome-client.js")).includes("/new-session"));
});

test("one connection card replaces the status line, banner, and hint", async (t) => {
  const { baseUrl } = await setup(t);
  const html = createChromeHtml({ key: "k", file: "f.html", status: "open", chat: [], revision: 0 }, { baseUrl });
  assert.ok(/<section id="connection" data-state="idle"/.test(html));
  for (const gone of ["presenceBanner", "agentStatus"]) assert.ok(!html.includes(`id="${gone}"`), gone);
  for (const id of ["connectClaude", "resumeClaude", "cancelConnect", "retryConnect", "copyAllow", "copyCommand", "viewLog", "sessionFeedback", "manualConnect", "pollCommand"]) {
    assert.ok(html.includes(`id="${id}"`), id);
  }
  const source = await fetchAsset(baseUrl, "chrome-client.js");
  for (const state of ["idle", "starting", "connected", "working", "stuck", "unsupported"]) assert.ok(source.includes(`"${state}"`), state);
  assert.ok(!/"[^"\n]*[Rr]econnecting[^"\n]*"/.test(source), "a reconnect cycle is never shown to the user (error codes aside)");
  assert.ok(source.includes("STUCK_AFTER_MS = 45000"));
  assert.ok(source.includes("Bash(see-plan:*)"));
  assert.ok(source.includes('"/api/claude-status"'));
});

test("panel UX: queue above tabs, destructive actions behind a menu and a confirm, first-run tip, ARIA tabs", async (t) => {
  const { baseUrl } = await setup(t);
  const html = createChromeHtml({ key: "k", file: "f.html", status: "open", chat: [], revision: 0 }, { baseUrl });
  assert.ok(html.indexOf('id="queuedLog"') < html.indexOf('id="tabs"'), "queued notes render above the tabs");
  const menu = /<span id="moreMenu"[^>]*>([\s\S]*?)<\/span>/.exec(html)[1];
  assert.ok(menu.includes('id="endSession"') && menu.includes('id="sendAndEnd"') && menu.includes('id="commentPlan"'));
  assert.ok(html.includes('<dialog id="confirmDialog"'));
  assert.ok(html.includes('aria-controls="chatPanel"') && html.includes('aria-controls="claudeLog"'));
  assert.ok(html.includes('id="resumeSession"') && html.includes('id="newSession"'));
  const source = await fetchAsset(baseUrl, "chrome-client.js");
  assert.ok(source.includes("Ctrl+I"), "first-run tip names the shortcut");
  assert.ok(source.includes("localStorage") && !source.includes("sessionStorage"), "the queue survives closing the tab");
  assert.ok(source.includes("ArrowRight") && source.includes("ArrowLeft"));
  assert.ok(source.includes('"/reopen"'));
  assert.ok(!/if \(claudeSessionId\) selectTab\(true\)/.test(source), "the log tab is not auto-selected");
});

test("session feedback, decisions, stages, revisions, and the log popover are wired", async (t) => {
  const { baseUrl } = await setup(t);
  const html = createChromeHtml({ key: "k", file: "f.html", status: "open", chat: [], revision: 0, stage: "plan" }, { baseUrl });
  for (const id of ["feedbackDialog", "decisionDialog", "decisionBar", "approve", "requestChanges", "stageSelect", "stageInferred", "revisionButton", "revisionMenu", "backToLatest", "logPopover", "logSend", "logError", "logBoth", "workflowBar", "skipStage", "nextStage", "previousRounds", "homeLink"]) {
    assert.ok(html.includes(`id="${id}"`), id);
  }
  for (const c of ["wrong-direction", "too-slow", "broke-something", "ignored-notes", "great-job"]) assert.ok(html.includes(`value="${c}"`), c);
  const source = await fetchAsset(baseUrl, "chrome-client.js");
  for (const route of ['"/session-feedback"', '"/decision"', '"/stage"', '"/revisions"', '"/api/claude-errors"', "/skip", "highlightChanges"]) {
    assert.ok(source.includes(route), route);
  }
  const sdk = await fetchAsset(baseUrl, "sdk.js");
  assert.ok(sdk.includes('"highlightChanges"'));
});

test("log entries never use innerHTML", async (t) => {
  const { baseUrl } = await setup(t);
  const source = await fetchAsset(baseUrl, "chrome-client.js");
  assert.equal(source.split("innerHTML").length - 1, 1, "only the existing chat bubble assigns innerHTML");
  const html = createChromeHtml({ key: "k", file: "f.html", status: "open", chat: [], revision: 0 }, { baseUrl });
  for (const id of ["tabChat", "tabLog", "claudeLog"]) assert.ok(html.includes(`id="${id}"`));
});

test("the recent-sessions picker is on the page and wired in the client", async (t) => {
  const { baseUrl } = await setup(t);
  const html = createChromeHtml({ key: "k", file: "f.html", status: "open", chat: [], revision: 0 }, { baseUrl });
  for (const id of ["claudeHeader", "claudeChange", "claudePicker", "claudeSessions", "claudeAttach"]) {
    assert.ok(html.includes(`id="${id}"`), id);
  }
  const source = await fetchAsset(baseUrl, "chrome-client.js");
  assert.ok(source.includes('"/api/claude-sessions"'));
  assert.ok(source.includes('"claude-log"'));
  assert.ok(source.includes("~/claude-errors/error-log.json"));
});

test("the Claude log page and its files are served", async (t) => {
  const { baseUrl } = await setup(t);
  const html = await (await fetch(`${baseUrl}/claude`)).text();
  for (const id of ["sessionId", "lastPrompt", "sessionSelect", "entries", "status"]) assert.ok(html.includes(`id="${id}"`), id);
  assert.ok(html.includes('<dialog id="logDialog"'), "a click opens a confirmation dialog");
  for (const id of ["logPreview", "logPreviewMeta", "logReason", "logConfirm", "logCancel"]) assert.ok(html.includes(`id="${id}"`), id);
  assert.match(html, /Why is this an error\? \(optional\)/);
  assert.ok(html.includes('src="/logs-client.js"') && html.includes('href="/logs.css"'));
  const client = await fetchAsset(baseUrl, "logs-client.js");
  assert.doesNotThrow(() => new Function(client), "logs-client.js has a syntax error");
  assert.ok(!client.includes("innerHTML"), "transcript text is set with textContent only");
  assert.ok(client.includes("/api/claude-errors") && client.includes("/api/claude-sessions/"));
  assert.ok(client.includes("showModal") && client.includes("ctrlKey") && client.includes("metaKey"), "the dialog confirms with Ctrl/Cmd+Enter");
  assert.ok(client.includes("reason: reason || null"), "the reason is sent with the entry");
  await fetchAsset(baseUrl, "logs.css");
});

test("the repository is MIT licensed with an upstream notice", async () => {
  const root = new URL("../", import.meta.url);
  const license = await fs.promises.readFile(new URL("LICENSE", root), "utf8");
  assert.match(license, /^MIT License/);
  const pkg = JSON.parse(await fs.promises.readFile(new URL("package.json", root), "utf8"));
  assert.equal(pkg.license, "MIT");
  assert.ok(pkg.files.includes("LICENSE") && pkg.files.includes("NOTICE") && !pkg.files.includes("test"));
  assert.match(await fs.promises.readFile(new URL("NOTICE", root), "utf8"), /lavish-axi.*Kun Chen/s);
});

// WCAG relative luminance and contrast ratio, for the severity badge colors.
function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

test("severity badges: plan colors, text at 4.5:1 or better in light and dark, in all three stylesheets", async (t) => {
  const { baseUrl } = await setup(t);
  const expected = {
    light: { low: "#E8730C", medium: "#F2B600", high: "#C62828", send_to_it: "#7B1E3A", unrated: "#6B7280" },
    dark: { low: "#FF9A3D", medium: "#FFC94D", high: "#FF5C5C", send_to_it: "#C2456A", unrated: "#9CA3AF" },
  };
  for (const name of ["errors.css", "logs.css", "chrome.css"]) {
    const css = await fetchAsset(baseUrl, name);
    const start = css.indexOf("---- severity");
    assert.ok(start > 0, `${name} has the severity block`);
    const block = css.slice(start);
    const darkAt = block.indexOf("@media (prefers-color-scheme: dark)");
    for (const [mode, part] of [["light", block.slice(0, darkAt)], ["dark", block.slice(darkAt)]]) {
      for (const [sev, bg] of Object.entries(expected[mode])) {
        const got = new RegExp(`--sev-${sev}-bg: (#[0-9A-Fa-f]{6})`).exec(part)?.[1];
        const fg = new RegExp(`--sev-${sev}-fg: (#[0-9A-Fa-f]{6})`).exec(part)?.[1];
        assert.equal(got?.toUpperCase(), bg, `${name} ${mode} ${sev} background`);
        assert.ok(fg === "#000000" || fg === "#FFFFFF", `${name} ${mode} ${sev} text is black or white`);
        assert.ok(contrast(bg, fg) >= 4.5, `${name} ${mode} ${sev}: ${contrast(bg, fg).toFixed(2)}:1`);
      }
    }
  }
});

test("the /claude dialog and the panel popover offer four severity radios, none checked", async (t) => {
  const { baseUrl } = await setup(t);
  const html = await (await fetch(`${baseUrl}/claude`)).text();
  const fieldset = /<fieldset id="logSeverity"[\s\S]*?<\/fieldset>/.exec(html)[0];
  assert.equal(fieldset.match(/type="radio"/g).length, 4);
  assert.ok(!fieldset.includes("checked"), "no severity is picked for the user");
  assert.ok(fieldset.includes("<legend>Severity</legend>"));
  for (const v of ["low", "medium", "high", "send_to_it"]) assert.ok(fieldset.includes(`value="${v}"`), v);
  assert.match(html, /id="logConfirm" type="submit" class="primary" disabled/);
  const client = await fetchAsset(baseUrl, "logs-client.js");
  assert.ok(client.includes("required for High and Send to IT") && client.includes("severity: severity"));

  const panel = createChromeHtml({ key: "k", file: "f.html", status: "open", chat: [], revision: 0 }, { baseUrl });
  const pop = /<div id="logPopover"[\s\S]*?<\/div>\s*<\/div>/.exec(panel)[0];
  assert.equal(pop.match(/type="radio"/g).length, 4);
  const chrome = await fetchAsset(baseUrl, "chrome-client.js");
  assert.ok(chrome.includes("target: { entry: entryRecord(entry), note: note,"), "the agent prompt payload is unchanged (no severity)");
  assert.ok(chrome.includes("entryRecord(entry, reason, severity)"), "only the error-log payload carries the severity");
});

test("the errors page script builds the DOM with textContent only", async (t) => {
  const { baseUrl } = await setup(t);
  const client = await fetchAsset(baseUrl, "errors-client.js");
  assert.ok(!client.includes("innerHTML"));
  for (const route of ["/api/errors/summary", "/api/errors/record", "/api/errors/rate", "/api/projects/", "/plans/open", "/api/claude-sessions?limit=75"]) assert.ok(client.includes(route), route);
  for (const key of ["ArrowRight", "ArrowLeft", "Home", "End", "encodeURIComponent", "document.hidden", "data-project", '[role="tab"]']) assert.ok(client.includes(key), key);
});
