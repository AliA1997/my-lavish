import { escapeHtml } from "./markdown.js";
import { SEVERITIES, SEVERITY_HINTS, SEVERITY_TITLES } from "./severity.js";

/** Four severity radios, none checked: the user has to pick one (D5). Keys 1-4 pick one too. */
export function severityOptions(name) {
  return SEVERITIES.map((s, i) => `<label class="severity-option sev-${s}"><input type="radio" name="${name}" value="${s}"><span class="swatch" aria-hidden="true"></span><span class="sev-label">${i + 1}. ${escapeHtml(SEVERITY_TITLES[s])}</span><span class="sev-hint">${escapeHtml(SEVERITY_HINTS[s])}</span></label>`).join("\n      ");
}

/** The full-page Claude log view: no plan, just the newest (or chosen) Claude session's transcript. */
export function createLogsHtml({ baseUrl, projectKey = null, errorLogFile = "the error log" } = {}) {
  const errorsHref = projectKey ? `/errors?project=${encodeURIComponent(projectKey)}` : "/errors";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Claude session logs</title>
<link rel="stylesheet" href="/logs.css">
</head>
<body data-base-url="${escapeHtml(baseUrl ?? "")}" data-error-log="${escapeHtml(errorLogFile)}">
<nav id="pageNav" aria-label="Pages"><a href="/">Dashboard</a> <a href="${escapeHtml(errorsHref)}">Error logs</a></nav>
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
<p id="tip">Click an entry to log it as an error in <code>${escapeHtml(errorLogFile)}</code>. You can say why before it is saved. <code>see-plan paths</code> shows where see-plan keeps its files.</p>
<p id="status" role="status" aria-live="polite"></p>
<main id="entries"></main>
<dialog id="logDialog" aria-labelledby="logDialogTitle">
  <form id="logForm" method="dialog">
    <h2 id="logDialogTitle">Log as error</h2>
    <p id="logPreviewMeta" class="preview-meta"></p>
    <blockquote id="logPreview"></blockquote>
    <fieldset id="logSeverity" class="severity-picker">
      <legend>Severity</legend>
      ${severityOptions("logSeverityChoice")}
    </fieldset>
    <p id="logSavedSeverity" class="saved-severity" hidden></p>
    <label for="logReason" id="logReasonLabel">Why is this an error? (optional)</label>
    <textarea id="logReason" rows="4" maxlength="2000"></textarea>
    <p id="logDialogHint" class="hint">Ctrl+Enter to log &middot; Esc to cancel</p>
    <div class="dialog-actions">
      <button id="logCancel" type="button">Cancel</button>
      <button id="logConfirm" type="submit" class="primary" disabled>Log as error</button>
    </div>
  </form>
</dialog>
<script src="/logs-client.js"></script>
</body>
</html>
`;
}
