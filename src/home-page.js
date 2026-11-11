import { escapeHtml } from "./markdown.js";

/**
 * The dashboard at `/`: features with their four-stage tracker (left), finished sessions (middle) and every
 * open session (right).
 */
export function createHomeHtml({ baseUrl } = {}) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>see-plan</title>
<link rel="stylesheet" href="/home.css">
</head>
<body data-base-url="${escapeHtml(baseUrl ?? "")}">
<header id="top">
  <div class="brand">
    <span class="logo" aria-hidden="true">&#9719;</span>
    <div>
      <h1>see-plan</h1>
      <p class="tagline">Review what your agent plans, on a page.</p>
    </div>
  </div>
  <nav aria-label="Pages">
    <a href="/" aria-current="page">Dashboard</a>
    <a href="/claude">Claude logs</a>
    <a href="/errors">Error logs</a>
    <button id="newFeature" type="button" class="primary">+ New feature</button>
  </nav>
</header>
<p id="status" role="status" aria-live="polite"></p>
<div id="layout">
  <main id="main" aria-labelledby="featuresTitle">
    <h2 id="featuresTitle">Features</h2>
    <p class="hint">Each feature runs four stages, each with its own Claude session: Plan → Interrogation → Implementation → Verification. A stage opens when the one before it is approved or skipped.</p>
    <div id="features"></div>
  </main>
  <aside id="history" aria-labelledby="historyTitle">
    <h2 id="historyTitle">History <span class="count" id="historyCount"></span></h2>
    <p class="hint">Finished sessions, newest first. Open one to read it or resume it.</p>
    <div id="historyList"></div>
  </aside>
  <aside id="sessionsPane" aria-labelledby="sessionsTitle">
    <h2 id="sessionsTitle">Sessions <span class="count" id="sessionsCount"></span></h2>
    <p class="hint">Everything open now, including each feature's stages.</p>
    <div id="sessions"></div>
  </aside>
</div>
<dialog id="featureDialog" aria-labelledby="featureDialogTitle">
  <form id="featureForm" method="dialog">
    <h2 id="featureDialogTitle">New feature</h2>
    <label for="featureName">Name <span class="hint">(letters, digits, dash; becomes the file prefix)</span></label>
    <input id="featureName" name="name" required pattern="[A-Za-z0-9][A-Za-z0-9._\\-]{0,63}" autocomplete="off" spellcheck="false">
    <label for="featureDir">Folder <span class="hint">(absolute path; the plan files are written here)</span></label>
    <input id="featureDir" name="dir" required autocomplete="off" spellcheck="false">
    <label for="featureRequirements">Requirements</label>
    <textarea id="featureRequirements" name="requirements" rows="8" required placeholder="What should this feature do? One requirement per line works well."></textarea>
    <label class="check"><input id="featureClaude" type="checkbox" checked> Start Claude for the Plan stage now</label>
    <p id="featureError" class="error" role="alert"></p>
    <div class="actions">
      <button type="button" id="featureCancel">Cancel</button>
      <button type="submit" id="featureCreate" class="primary">Create feature</button>
    </div>
  </form>
</dialog>
<script src="/home-client.js"></script>
</body>
</html>
`;
}
