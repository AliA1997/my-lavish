import { escapeHtml } from "./markdown.js";
import { severityOptions } from "./logs-page.js";

export const ERROR_TABS = [
  { id: "session-errors", title: "Session Error Logs" },
  { id: "plan-errors", title: "Plan Error Logs" },
  { id: "plans", title: "Plans" },
  { id: "sessions", title: "Sessions" },
];

function tab({ id, title }, i) {
  return `<button type="button" role="tab" id="tab-${id}" aria-controls="panel-${id}" aria-selected="${i === 0}" tabindex="${i === 0 ? 0 : -1}" data-tab="${id}"><span class="tab-title">${escapeHtml(title)}</span> <span class="count" data-count="${id}"></span></button>`;
}

function panel({ id, title }, i) {
  return `<section role="tabpanel" id="panel-${id}" aria-labelledby="tab-${id}" tabindex="0" data-panel="${id}"${i === 0 ? "" : " hidden"}><h2 class="visually-hidden">${escapeHtml(title)}</h2><div class="panel-body"></div></section>`;
}

/** The tabbed error-log view at /errors: session errors, plan errors, recent plans and recent Claude sessions. */
export function createErrorsHtml({ baseUrl } = {}) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Error logs</title>
<link rel="stylesheet" href="/errors.css">
</head>
<body data-base-url="${escapeHtml(baseUrl ?? "")}">
<header id="top">
  <div>
    <p class="eyebrow">see-plan</p>
    <h1>Error logs</h1>
  </div>
  <nav aria-label="Pages"><a href="/">Dashboard</a> <a href="/claude">Claude logs</a></nav>
</header>
<p id="status" role="status" aria-live="polite"></p>
<div role="tablist" id="tabs" aria-label="Error log views">
  ${ERROR_TABS.map(tab).join("\n  ")}
</div>
${ERROR_TABS.map(panel).join("\n")}
<dialog id="rateDialog" aria-labelledby="rateDialogTitle">
  <form id="rateForm" method="dialog">
    <h2 id="rateDialogTitle">Rate this error</h2>
    <blockquote id="ratePreview"></blockquote>
    <fieldset id="rateSeverity" class="severity-picker">
      <legend>Severity</legend>
      ${severityOptions("rateSeverityChoice")}
    </fieldset>
    <label for="rateReason" id="rateReasonLabel">Why is this an error? (optional)</label>
    <textarea id="rateReason" rows="3" maxlength="2000"></textarea>
    <p class="hint">A severity can be set once. Esc to cancel.</p>
    <p id="rateError" class="error" role="alert"></p>
    <div class="dialog-actions">
      <button id="rateCancel" type="button">Cancel</button>
      <button id="rateConfirm" type="submit" class="primary" disabled>Save severity</button>
    </div>
  </form>
</dialog>
<script src="/errors-client.js"></script>
</body>
</html>
`;
}
