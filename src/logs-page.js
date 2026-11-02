import { escapeHtml } from "./markdown.js";

/** The full-page Claude log view: no plan, just the newest (or chosen) Claude session's transcript. */
export function createLogsHtml({ baseUrl } = {}) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Claude session logs</title>
<link rel="stylesheet" href="/logs.css">
</head>
<body data-base-url="${escapeHtml(baseUrl ?? "")}">
<header id="top">
  <div id="identity">
    <p class="eyebrow">Claude session</p>
    <h1 id="sessionId">Loading&hellip;</h1>
    <p id="sessionMeta"><span id="lastPrompt"></span><span id="project"></span></p>
  </div>
  <div id="switcher">
    <label for="sessionSelect">Recent sessions</label>
    <select id="sessionSelect"></select>
  </div>
</header>
<p id="tip">Click an entry to add it to ~/claude-errors/error-log.json.</p>
<p id="status" role="status" aria-live="polite"></p>
<main id="entries"></main>
<script src="/logs-client.js"></script>
</body>
</html>
`;
}
