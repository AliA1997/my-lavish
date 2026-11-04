import { escapeHtml } from "./markdown.js";
import { severityOptions } from "./logs-page.js";

export const ERROR_TABS = [
  { id: "session-errors", title: "Session Error Logs" },
  { id: "plan-errors", title: "Plan Error Logs" },
  { id: "plans", title: "Plans" },
  { id: "sessions", title: "Sessions" },
];

/** D13: outside a project the page has only the Sessions tab. */
export const SESSIONS_ONLY_TABS = ERROR_TABS.filter((t) => t.id === "sessions");

function tab({ id, title }, i) {
  return `<button type="button" role="tab" id="tab-${id}" aria-controls="panel-${id}" aria-selected="${i === 0}" tabindex="${i === 0 ? 0 : -1}" data-tab="${id}"><span class="tab-title">${escapeHtml(title)}</span> <span class="count" data-count="${id}"></span></button>`;
}

function panel({ id, title }, i) {
  return `<section role="tabpanel" id="panel-${id}" aria-labelledby="tab-${id}" tabindex="0" data-panel="${id}"${i === 0 ? "" : " hidden"}><h2 class="visually-hidden">${escapeHtml(title)}</h2><div class="panel-body"></div></section>`;
}

const projectHref = (key) => `/errors?project=${encodeURIComponent(key)}`;

function scopeLine({ project, recentProjects = [], unknownProject = false }) {
  if (project) {
    return `<p id="scope" class="scope">Project: <strong title="${escapeHtml(project.root)}">${escapeHtml(project.name)}</strong></p>`;
  }
  const note = unknownProject ? `<p class="scope-note">That project isn't registered; run <code>see-plan error-logs</code> in it.</p>` : "";
  const recent = recentProjects.length
    ? `<p class="scope-recent">Recent projects: ${recentProjects.map((p) => `<a href="${escapeHtml(projectHref(p.key))}" title="${escapeHtml(p.root)}">${escapeHtml(p.name)}</a>`).join(" · ")}</p>`
    : "";
  return `<div id="scope" class="scope sessions-only">${note}<p>Not in a project folder, so only recent sessions are shown. Run <code>see-plan error-logs</code> in a project folder for error logs and plans.</p>${recent}</div>`;
}

/**
 * The tabbed error-log view at /errors. With a project (D10): session errors, plan errors, the project's
 * superpowers plans and recent Claude sessions. Without one (D13): only the Sessions tab.
 */
export function createErrorsHtml({ baseUrl, project = null, recentProjects = [], unknownProject = false } = {}) {
  const tabs = project ? ERROR_TABS : SESSIONS_ONLY_TABS;
  const q = project ? `?project=${encodeURIComponent(project.key)}` : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${project ? `Error logs · ${escapeHtml(project.name)}` : "Recent sessions"}</title>
<link rel="stylesheet" href="/errors.css">
</head>
<body data-base-url="${escapeHtml(baseUrl ?? "")}" data-project="${escapeHtml(project?.key ?? "")}" data-mode="${project ? "project" : "sessions-only"}">
<header id="top">
  <div>
    <p class="eyebrow">see-plan</p>
    <h1>${project ? "Error logs" : "Recent sessions"}</h1>
  </div>
  <nav aria-label="Pages"><a href="/">Dashboard</a> <a href="/claude${escapeHtml(q)}">Claude logs</a></nav>
</header>
${scopeLine({ project, recentProjects, unknownProject })}
<p id="status" role="status" aria-live="polite"></p>
<div role="tablist" id="tabs" aria-label="${project ? "Error log views" : "Sessions"}">
  ${tabs.map(tab).join("\n  ")}
</div>
${tabs.map(panel).join("\n")}
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
