/* see-plan dashboard: features with their stage tracker, and loose review sessions.
 * Classic script. Every server string is set with textContent. */
(function () {
  "use strict";

  var STAGES = ["plan", "interrogation", "implementation", "verification"];
  var TITLES = { plan: "Plan", interrogation: "Interrogation", implementation: "Implementation", verification: "Verification" };
  var RECONNECT_DELAYS_MS = [1000, 2000, 5000];

  function $(id) { return document.getElementById(id); }
  var featuresEl = $("features");
  var sessionsEl = $("sessions");
  var statusEl = $("status");
  var dialog = $("featureDialog");
  var form = $("featureForm");
  var errorEl = $("featureError");
  var reconnectAttempt = 0;
  var lastDir = "";
  var data = { sessions: [], workflows: [] };

  function element(tag, className, text) {
    var el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  }

  function baseName(p) {
    var parts = String(p || "").split(/[\\/]/);
    return parts[parts.length - 1] || String(p || "");
  }

  function dirName(p) {
    var s = String(p || "");
    var i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
    return i > 0 ? s.slice(0, i) : "";
  }

  function timeAgo(iso) {
    var t = Date.parse(iso);
    if (!isFinite(t)) return "";
    var min = Math.round((Date.now() - t) / 60000);
    if (min < 1) return "just now";
    if (min < 60) return min + " min ago";
    if (min < 1440) return Math.round(min / 60) + " h ago";
    return Math.round(min / 1440) + " d ago";
  }

  function sessionByKey(k) {
    for (var i = 0; i < data.sessions.length; i++) if (data.sessions[i].key === k) return data.sessions[i];
    return null;
  }

  function agentLabel(s) {
    if (!s) return "";
    if (s.agent === "working") return "agent working";
    if (s.agent) return "agent connected";
    return "";
  }

  function renderFeatures() {
    featuresEl.textContent = "";
    var list = data.workflows.slice().sort(function (a, b) { return String(b.updated_at).localeCompare(String(a.updated_at)); });
    if (!list.length) {
      featuresEl.appendChild(element("p", "empty", "No features yet. Press New feature to start one from your requirements."));
      return;
    }
    list.forEach(function (wf) {
      var row = element("article", "feature");
      var head = element("div", "feature-head");
      head.appendChild(element("h3", "", wf.name));
      head.appendChild(element("span", "muted", wf.dir));
      row.appendChild(head);
      var track = element("ol", "track");
      STAGES.forEach(function (s, i) {
        var st = wf.stages && wf.stages[s] ? wf.stages[s] : { status: "locked" };
        var li = element("li", "step " + String(st.status).replace(/[^a-z]/g, ""));
        var session = st.key ? sessionByKey(st.key) : null;
        var label = (i + 1) + ". " + TITLES[s];
        if (session && st.status !== "locked") {
          var a = element("a", "", label);
          a.href = session.url;
          li.appendChild(a);
        } else {
          li.appendChild(element("span", "", label));
        }
        var note = st.status === "done" ? "done" : st.status === "skipped" ? "skipped" : st.status === "current" ? "current" : "locked";
        var agent = agentLabel(session);
        li.appendChild(element("span", "step-note", note + (agent && st.status === "current" ? " · " + agent : "")));
        track.appendChild(li);
      });
      row.appendChild(track);
      var current = wf.current && wf.stages[wf.current] && wf.stages[wf.current].key ? sessionByKey(wf.stages[wf.current].key) : null;
      var actions = element("div", "feature-actions");
      if (current) {
        var go = element("a", "button primary", "Open " + TITLES[wf.current] + " →");
        go.href = current.url;
        actions.appendChild(go);
      } else if (!wf.current) {
        actions.appendChild(element("span", "done-label", "All stages finished ✓"));
      }
      row.appendChild(actions);
      featuresEl.appendChild(row);
      if (!lastDir) lastDir = wf.dir;
    });
  }

  function featureOf(s) {
    if (!s.workflow_id) return "";
    for (var i = 0; i < data.workflows.length; i++) if (data.workflows[i].id === s.workflow_id) return data.workflows[i].name;
    return "feature";
  }

  function statusOf(s) {
    return s.status === "ended" ? (s.ended_by === "approved" ? "approved" : "ended") : s.status === "feedback" ? "notes waiting" : "open";
  }

  function sessionCard(s, opts) {
    var card = element("article", "scard status-" + statusOf(s).replace(/\s/g, "-"));
    var a = element("a", "sname", baseName(s.file));
    a.href = s.url;
    a.title = s.file;
    card.appendChild(a);
    var meta = element("div", "smeta");
    meta.appendChild(element("span", "pill pill-" + statusOf(s).replace(/\s/g, "-"), statusOf(s)));
    var feature = featureOf(s);
    var stage = s.stage ? TITLES[s.stage] : "";
    if (feature || stage) meta.appendChild(element("span", "muted", (feature ? feature + " · " : "") + stage));
    card.appendChild(meta);
    var foot = element("div", "sfoot");
    var agent = agentLabel(s);
    foot.appendChild(element("span", "muted", timeAgo(s.updated_at) + (agent && !opts.history ? " · " + agent : "")));
    if (!s.workflow_id && !opts.history) {
      var archive = element("button", "link", "Archive");
      archive.type = "button";
      archive.title = "Hide this session from the dashboard (it comes back if it is opened again)";
      archive.addEventListener("click", function () { archiveSession(s.key, archive); });
      foot.appendChild(archive);
    }
    if (opts.history) {
      var open = element("a", "", "Open");
      open.href = s.url;
      foot.appendChild(open);
    }
    card.appendChild(foot);
    return card;
  }

  function renderList(target, countEl, list, emptyText, opts) {
    target.textContent = "";
    countEl.textContent = list.length ? String(list.length) : "";
    if (!list.length) {
      target.appendChild(element("p", "empty", emptyText));
      return;
    }
    list.forEach(function (s) {
      target.appendChild(sessionCard(s, opts));
      if (!lastDir && !s.workflow_id) lastDir = dirName(s.file);
    });
  }

  function renderSessions() {
    var byNewest = function (a, b) { return String(b.updated_at).localeCompare(String(a.updated_at)); };
    var live = data.sessions.filter(function (s) { return s.status !== "ended"; }).sort(byNewest);
    var done = data.sessions.filter(function (s) { return s.status === "ended"; }).sort(byNewest);
    renderList(sessionsEl, $("sessionsCount"), live, "Nothing open. Ask your agent to run see-plan <file>.", { history: false });
    renderList($("historyList"), $("historyCount"), done, "Nothing finished yet.", { history: true });
  }

  function render() {
    renderFeatures();
    renderSessions();
  }

  function readJson(res) {
    return res.json().catch(function () { return null; });
  }

  function errorMessage(body, status) {
    var err = body && body.error;
    return (err && (err.message || err.code)) || "Request failed (HTTP " + status + ")";
  }

  function post(path, body) {
    return fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) })
      .then(function (res) { return readJson(res).then(function (json) { return { ok: res.ok, status: res.status, body: json }; }); });
  }

  function archiveSession(k, button) {
    button.disabled = true;
    post("/api/" + encodeURIComponent(k) + "/archive", { archived: true }).then(function (r) {
      if (!r.ok) {
        button.disabled = false;
        statusEl.textContent = errorMessage(r.body, r.status);
      } else {
        statusEl.textContent = "Archived.";
      }
    }, function () {
      button.disabled = false;
      statusEl.textContent = "Could not reach see-plan.";
    });
  }

  function openDialog() {
    errorEl.textContent = "";
    if (!$("featureDir").value) $("featureDir").value = lastDir;
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    $("featureName").focus();
  }

  function closeDialog() {
    if (typeof dialog.close === "function") dialog.close();
    else dialog.removeAttribute("open");
  }

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    var name = $("featureName").value.trim();
    var dir = $("featureDir").value.trim();
    var requirements = $("featureRequirements").value;
    if (!name || !dir || !requirements.trim()) {
      errorEl.textContent = "Name, folder, and requirements are all needed.";
      return;
    }
    var create = $("featureCreate");
    create.disabled = true;
    errorEl.textContent = "";
    post("/api/workflows", { name: name, dir: dir, requirements: requirements })
      .then(function (r) {
        if (!r.ok) {
          errorEl.textContent = errorMessage(r.body, r.status);
          return;
        }
        var go = function () { window.location.href = r.body.url; };
        if (!$("featureClaude").checked) return go();
        return post("/api/" + encodeURIComponent(r.body.key) + "/connect-claude", {}).then(go, go);
      })
      .catch(function () { errorEl.textContent = "Could not reach see-plan."; })
      .then(function () { create.disabled = false; });
  });
  $("featureCancel").addEventListener("click", closeDialog);
  $("newFeature").addEventListener("click", openDialog);

  function connect() {
    var ws;
    try {
      ws = new WebSocket((window.location.protocol === "https:" ? "wss:" : "ws:") + "//" + window.location.host + "/events/home");
    } catch (e) {
      return scheduleReconnect();
    }
    ws.addEventListener("open", function () { reconnectAttempt = 0; });
    ws.addEventListener("message", function (event) {
      var msg;
      try {
        msg = JSON.parse(event.data);
      } catch (e) {
        return;
      }
      if (msg && msg.type === "sessions" && Array.isArray(msg.sessions)) {
        data = { sessions: msg.sessions, workflows: Array.isArray(msg.workflows) ? msg.workflows : [] };
        render();
      }
    });
    ws.addEventListener("close", scheduleReconnect);
  }

  function scheduleReconnect() {
    var delay = RECONNECT_DELAYS_MS[Math.min(reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
    reconnectAttempt++;
    setTimeout(connect, delay);
  }

  fetch("/api/sessions")
    .then(readJson)
    .then(function (body) {
      if (body && Array.isArray(body.sessions)) {
        data = { sessions: body.sessions, workflows: Array.isArray(body.workflows) ? body.workflows : [] };
        render();
      }
    })
    .catch(function () { statusEl.textContent = "Could not reach see-plan."; });
  connect();
})();
