import fs from "node:fs";
import { escapeHtml, serializeChat } from "./markdown.js";
import { CATEGORY_TITLES, SESSION_FEEDBACK_CATEGORIES, STAGES, STAGE_TITLES } from "./stages.js";

function artifactTitle(session) {
  try {
    const html = fs.readFileSync(session.file, "utf8");
    const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const t = m && m[1].trim();
    if (t) return t.replace(/<[^>]*>/g, "");
  } catch {
    // unreadable file: fall back to the default title
  }
  return "my-lavish-axi";
}

function quoteArg(p) {
  return /[\s"'`$&|;<>()*?!#~^%{}\[\]\\]/.test(p) ? JSON.stringify(p) : p;
}

function workflowView(wf, baseUrl) {
  if (!wf) return null;
  const stages = {};
  for (const s of STAGES) {
    const st = wf.stages[s];
    stages[s] = { status: st.status, url: st.key ? `${baseUrl}/session/${st.key}` : null, key: st.key ?? null };
  }
  return { id: wf.id, name: wf.name, current: wf.current, stages };
}

export function createChromeHtml(session, { baseUrl, canResume = false, workflow = null } = {}) {
  const file = session.source_file ?? session.file;
  const data = {
    key: session.key,
    file: session.file,
    status: session.status,
    ended_by: session.ended_by ?? null,
    chat: serializeChat(session.chat ?? []),
    claude_session_id: session.claude_session_id ?? null,
    can_resume: Boolean(canResume),
    stage: session.stage ?? null,
    stage_source: session.stage_source ?? null,
    has_plan: Boolean(session.source_file) || Boolean(session.stage),
    revision: session.revision ?? 0,
    decision: session.decision?.value ?? null,
    poll_command: `see-plan poll ${quoteArg(file)}${session.stage ? ` --stage ${session.stage}` : ""}`,
    history: (session.history ?? []).map((h) => ({ ended_at: h.ended_at ?? null, ended_by: h.ended_by ?? null, chat: serializeChat(h.chat ?? []) })),
    workflow: workflowView(workflow, baseUrl ?? ""),
  };
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  const title = escapeHtml(artifactTitle(session));
  const src = `/artifact/${encodeURIComponent(session.key)}/index.html?rev=${session.revision}`;
  const stageOptions = STAGES.map((s) => `<option value="${s}">${STAGE_TITLES[s]}</option>`).join("");
  const chips = SESSION_FEEDBACK_CATEGORIES.map(
    (c) => `<label class="chip"><input type="checkbox" name="category" value="${c}"> ${escapeHtml(CATEGORY_TITLES[c])}</label>`,
  ).join("\n        ");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<link rel="stylesheet" href="/chrome.css">
</head>
<body data-base-url="${escapeHtml(baseUrl ?? "")}">
<div id="app">
  <main id="stage">
    <div id="revisionBar" role="status" hidden><span id="revisionBarText"></span> <button id="backToLatest" type="button">Back to latest</button></div>
    <iframe id="artifact" title="Artifact under review" sandbox="allow-scripts allow-forms allow-popups" src="${src}"></iframe>
  </main>
  <aside id="panel" aria-label="Review panel">
    <header id="panelHeader">
      <a id="homeLink" href="/">&larr; All sessions</a>
      <span id="stageBox">
        <label for="stageSelect" class="sr-only">Stage</label>
        <select id="stageSelect" title="What stage is this session?"><option value="">No stage</option>${stageOptions}</select>
        <span id="stageInferred" hidden><span class="muted">(inferred)</span> <button id="stageConfirm" type="button" class="link">Confirm</button></span>
      </span>
      <span id="revisionBox">
        <button id="revisionButton" type="button" aria-haspopup="menu" aria-expanded="false" aria-controls="revisionMenu">Revision r0 &#9662;</button>
        <span id="revisionMenu" role="menu" hidden></span>
      </span>
    </header>
    <section id="connection" data-state="idle" aria-label="Agent connection">
      <p id="connectionText" role="status" aria-live="polite"><span class="dot" aria-hidden="true"></span><span id="connectionLabel"></span></p>
      <div id="connectionActions">
        <button id="connectClaude" type="button" class="primary">Connect Claude</button>
        <button id="resumeClaude" type="button" hidden>Resume last session</button>
        <button id="cancelConnect" type="button" hidden>Cancel</button>
        <button id="retryConnect" type="button" hidden>Try again</button>
        <button id="copyAllow" type="button" hidden>Copy allow-rule</button>
        <button id="copyCommand" type="button" hidden>Copy command</button>
        <button id="viewLog" type="button" hidden>View log</button>
        <button id="sessionFeedback" type="button">Session feedback</button>
      </div>
      <pre id="commandBox" hidden></pre>
      <details id="manualConnect">
        <summary>How do I connect manually?</summary>
        <p>Ask your agent to run this in the project folder, and to run it again each time it returns:</p>
        <code id="pollCommand"></code> <button id="copyPoll" type="button">Copy</button>
      </details>
    </section>
    <section id="workflowBar" hidden aria-label="Feature stages">
      <ol id="stageTrack"></ol>
      <button id="skipStage" type="button" class="link">Skip to next stage</button>
    </section>
    <section id="nextStage" role="status" hidden>
      <p id="nextStageText"></p>
      <button id="nextStageGo" type="button" class="primary"></button>
    </section>
    <div id="endedBanner" role="status" hidden>
      <span id="endedText">Session ended</span>
      <span class="ended-actions">
        <button id="resumeSession" type="button">Resume (keep history)</button>
        <button id="newSession" type="button" hidden>Start fresh</button>
      </span>
    </div>
    <div id="queuedLog" aria-label="Queued notes"></div>
    <div id="tabs" role="tablist" aria-label="Panel views">
      <button id="tabChat" type="button" role="tab" aria-selected="true" aria-controls="chatPanel" tabindex="0">Chat</button>
      <button id="tabLog" type="button" role="tab" aria-selected="false" aria-controls="claudeLog" tabindex="-1">Claude log</button>
    </div>
    <div id="chatPanel" role="tabpanel" aria-labelledby="tabChat">
      <details id="previousRounds" hidden>
        <summary>Previous rounds (<span id="roundCount">0</span>)</summary>
        <div id="roundsLog"></div>
      </details>
      <div id="chatLog"></div>
    </div>
    <div id="claudeLog" role="tabpanel" aria-labelledby="tabLog" hidden>
      <div id="claudeHeader" hidden>
        <span id="claudeCurrent"></span>
        <button id="claudeChange" type="button">Change session</button>
        <p class="claude-tip">Click an entry to add a note, send it to the agent, or log it as an error.</p>
      </div>
      <p id="claudeStatus"></p>
      <div id="claudePicker" hidden>
        <p class="picker-title">Recent Claude sessions</p>
        <div id="claudeSessions"></div>
        <div id="claudeAttach">
          <input id="claudeSessionInput" type="text" placeholder="Or paste a Claude session id" aria-label="Claude session id" autocomplete="off" spellcheck="false">
          <button id="claudeAttachButton" type="button">Attach</button>
        </div>
      </div>
      <div id="claudeEntries"></div>
    </div>
    <div id="decisionBar" hidden>
      <button id="approve" type="button" class="approve">Approve plan</button>
      <button id="requestChanges" type="button">Request changes</button>
    </div>
    <div id="composer">
      <textarea id="chatInput" rows="3" placeholder="Message the agent" aria-label="Message the agent"></textarea>
      <div id="composerRow">
        <button id="annotateToggle" type="button" title="Ctrl+I">Annotate</button>
        <span id="moreBox">
          <button id="moreButton" type="button" aria-haspopup="menu" aria-expanded="false" aria-controls="moreMenu">&#8943; More</button>
          <span id="moreMenu" role="menu" hidden>
            <button id="commentPlan" type="button" role="menuitem">Comment on the whole plan</button>
            <button id="sendAndEnd" type="button" role="menuitem">Send &amp; End</button>
            <button id="endSession" type="button" role="menuitem" class="danger">End session</button>
          </span>
        </span>
        <button id="send" type="button" class="primary">Send to Agent</button>
      </div>
      <p id="sendHint" role="status" aria-live="polite"></p>
    </div>
  </aside>
</div>
<div id="logPopover" role="dialog" aria-label="Claude log entry" hidden>
  <label for="logNote">Note to agent / reason (optional)</label>
  <textarea id="logNote" rows="3" placeholder="What went wrong here?"></textarea>
  <div class="popover-actions">
    <button id="logSend" type="button" class="primary">Send to agent</button>
    <button id="logError" type="button">Log as error</button>
    <button id="logBoth" type="button">Both</button>
    <button id="logCancel" type="button" class="link">Cancel</button>
  </div>
</div>
<dialog id="confirmDialog" aria-labelledby="confirmTitle">
  <h2 id="confirmTitle"></h2>
  <p id="confirmText"></p>
  <div class="actions">
    <button id="confirmCancel" type="button">Keep working</button>
    <button id="confirmOk" type="button" class="danger"></button>
  </div>
</dialog>
<dialog id="decisionDialog" aria-labelledby="decisionTitle">
  <h2 id="decisionTitle"></h2>
  <label for="decisionComment" id="decisionLabel">Comment</label>
  <textarea id="decisionComment" rows="4"></textarea>
  <p id="decisionError" class="error" role="alert"></p>
  <div class="actions">
    <button id="decisionCancel" type="button">Cancel</button>
    <button id="decisionOk" type="button" class="primary"></button>
  </div>
</dialog>
<dialog id="feedbackDialog" aria-labelledby="feedbackTitle">
  <form id="feedbackForm" method="dialog">
    <h2 id="feedbackTitle">How is this session going?</h2>
    <fieldset class="rating">
      <legend>Rating</legend>
      <label class="chip"><input type="radio" name="rating" value="up" required> &#128077; Good</label>
      <label class="chip"><input type="radio" name="rating" value="down"> &#128078; Not good</label>
    </fieldset>
    <fieldset>
      <legend>What stood out? (optional)</legend>
      <div class="chips">
        ${chips}
      </div>
    </fieldset>
    <label for="feedbackText">Anything else? (optional)</label>
    <textarea id="feedbackText" rows="3"></textarea>
    <p id="feedbackError" class="error" role="alert"></p>
    <div class="actions">
      <button id="feedbackCancel" type="button">Cancel</button>
      <button id="feedbackSend" type="submit" class="primary">Send feedback</button>
    </div>
  </form>
</dialog>
<script type="application/json" id="my-lavish-session">${json}</script>
<script src="/chrome-client.js"></script>
</body>
</html>
`;
}
