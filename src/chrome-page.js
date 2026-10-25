import fs from "node:fs";
import { escapeHtml, serializeChat } from "./markdown.js";

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

export function createChromeHtml(session, { baseUrl } = {}) {
  const data = {
    key: session.key,
    file: session.file,
    status: session.status,
    ended_by: session.ended_by ?? null,
    chat: serializeChat(session.chat ?? []),
  };
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  const title = escapeHtml(artifactTitle(session));
  const src = `/artifact/${encodeURIComponent(session.key)}/index.html?rev=${session.revision}`;
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
    <iframe id="artifact" sandbox="allow-scripts allow-forms allow-popups" src="${src}"></iframe>
  </main>
  <aside id="panel">
    <div id="presenceBanner" hidden></div>
    <div id="endedBanner" role="status" hidden>Session ended<button id="newSession" type="button" hidden>Start new session</button></div>
    <div id="chatLog"></div>
    <div id="queuedLog"></div>
    <div id="composer">
      <button id="annotateToggle" type="button">Annotate</button>
      <textarea id="chatInput" rows="3" placeholder="Message the agent"></textarea>
      <button id="send" type="button">Send to Agent</button>
      <button id="sendAndEnd" type="button">Send &amp; End</button>
      <button id="endSession" type="button">End session</button>
      <p id="sendHint" role="status" aria-live="polite"></p>
    </div>
  </aside>
</div>
<script type="application/json" id="my-lavish-session">${json}</script>
<script src="/chrome-client.js"></script>
</body>
</html>
`;
}
