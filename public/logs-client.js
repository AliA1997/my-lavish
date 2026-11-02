/* see-plan Claude log page: shows one Claude session's transcript; a click adds an entry to the error log. */
(function () {
  "use strict";

  var ERROR_LOG = "~/claude-errors/error-log.json";
  var POLL_MS = 2000;
  var LIST_MS = 30000;
  var MAX_ENTRIES = 1000;

  var sessionIdEl = document.getElementById("sessionId");
  var lastPromptEl = document.getElementById("lastPrompt");
  var projectEl = document.getElementById("project");
  var select = document.getElementById("sessionSelect");
  var statusEl = document.getElementById("status");
  var entriesEl = document.getElementById("entries");

  var sessions = [];
  var current = null; // { id, modified_at, cwd, project }
  var next = null; // byte offset for the next read, null = start from the tail
  var lastPromptAt = null;
  var reported = {}; // "<uuid>:<part>" -> true
  var timer = null;
  var busy = false;
  var generation = 0; // bumped on every switch so a late answer for the old session is dropped

  function element(tag, className, text) {
    var el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text; // textContent only: transcripts are untrusted
    return el;
  }

  function readJson(res) {
    return res.json().catch(function () { return null; });
  }

  function setStatus(text, isError) {
    statusEl.textContent = text;
    statusEl.classList.toggle("error", Boolean(isError));
  }

  function formatDate(iso) {
    var t = Date.parse(iso);
    if (!isFinite(t)) return "";
    return new Date(t).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  }

  function formatTime(iso) {
    var t = Date.parse(iso);
    return isFinite(t) ? new Date(t).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : "";
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

  function projectLabel(s) {
    var parts = String(s.cwd || "").split(/[\\/]/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : String(s.project || "");
  }

  function clip(text, n) {
    text = String(text || "");
    return text.length > n ? text.slice(0, n - 1) + "…" : text;
  }

  function renderHeader() {
    sessionIdEl.textContent = current ? current.id : "No Claude sessions found";
    lastPromptEl.textContent = !current ? ""
      : lastPromptAt ? "Last prompt " + formatDate(lastPromptAt)
      : current.modified_at ? "Last activity " + formatDate(current.modified_at)
      : "";
    var project = current ? projectLabel(current) : "";
    projectEl.textContent = project ? " · " + project : "";
    projectEl.title = current && current.cwd ? String(current.cwd) : "";
    document.title = current ? "Claude log · " + current.id.slice(0, 8) : "Claude session logs";
  }

  function renderSelect() {
    select.textContent = "";
    var list = sessions.slice();
    if (current && !list.some(function (s) { return s.id === current.id; })) list.unshift(current);
    list.forEach(function (s) {
      var option = element("option", "", [clip(s.title || "(no prompt)", 70), projectLabel(s), timeAgo(s.modified_at)].filter(Boolean).join(" · "));
      option.value = s.id;
      option.selected = Boolean(current && s.id === current.id);
      select.appendChild(option);
    });
    select.disabled = !list.length;
  }

  function nearBottom() {
    var doc = document.documentElement;
    return doc.scrollHeight - (window.scrollY + window.innerHeight) < 120;
  }

  function refOf(entry) {
    return typeof entry.uuid === "string" ? entry.uuid + ":" + (Number(entry.part) || 0) : "";
  }

  function addEntry(entry) {
    if (!entry || typeof entry !== "object") return;
    var row = element("article", "entry " + String(entry.kind || "text").replace(/[^a-z_]/g, "") + (entry.role === "assistant" ? " assistant" : " user"));
    var label = element("div", "label");
    var kind = entry.kind === "tool_use" ? " · tool call" : entry.kind === "tool_result" ? " · tool result" : "";
    label.appendChild(element("span", "who", (entry.role === "assistant" ? "Claude" : "User") + kind));
    if (entry.at) label.appendChild(element("time", "at", formatTime(entry.at)));
    row.appendChild(label);
    row.appendChild(element("div", "text", String(entry.text || "")));
    var ref = refOf(entry);
    if (ref) {
      row.tabIndex = 0;
      row.setAttribute("role", "button");
      row.title = (entry.at ? formatDate(entry.at) + "\n" : "") + "Click to add this entry to " + ERROR_LOG;
      if (reported[ref]) row.classList.add("logged");
      row.addEventListener("click", function () {
        var selection = window.getSelection ? window.getSelection() : null;
        if (selection && !selection.isCollapsed && row.contains(selection.anchorNode)) return; // copying text
        logEntry(entry, row);
      });
      row.addEventListener("keydown", function (event) {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          logEntry(entry, row);
        }
      });
    }
    entriesEl.appendChild(row);
  }

  function logEntry(entry, row) {
    if (row.classList.contains("logged")) {
      setStatus("That entry is already in " + ERROR_LOG + ".", false);
      return;
    }
    if (row.classList.contains("saving")) return;
    row.classList.add("saving");
    fetch("/api/claude-errors", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        entry: {
          claude_session_id: current.id,
          uuid: entry.uuid,
          part: Number(entry.part) || 0,
          role: String(entry.role || ""),
          kind: String(entry.kind || ""),
          at: entry.at ? String(entry.at) : null,
          text: String(entry.text || ""),
        },
      }),
    })
      .then(function (res) {
        return readJson(res).then(function (body) {
          if (res.ok) {
            reported[refOf(entry)] = true;
            row.classList.add("logged");
            setStatus((body && body.duplicate ? "Already in " : "Added to ") + ERROR_LOG + ".", false);
          } else {
            setStatus(body && body.error && body.error.message ? body.error.message : "Could not write the error log (HTTP " + res.status + ").", true);
          }
        });
      })
      .catch(function (e) {
        setStatus("Could not reach see-plan: " + (e && e.message ? e.message : e), true);
      })
      .then(function () {
        row.classList.remove("saving");
      });
  }

  function refresh() {
    clearTimeout(timer);
    if (!current || busy) return;
    busy = true;
    var mine = generation;
    var url = "/api/claude-sessions/" + encodeURIComponent(current.id) + "/log" + (next === null ? "" : "?after=" + next);
    fetch(url)
      .then(readJson)
      .then(function (body) {
        if (mine !== generation || !body || !Array.isArray(body.entries)) return;
        if (!body.found) {
          setStatus("No transcript found for this session.", true);
          return;
        }
        var first = next === null;
        var stick = first || nearBottom();
        if (Array.isArray(body.reported)) body.reported.forEach(function (ref) { reported[ref] = true; });
        if (body.omitted && !first) entriesEl.textContent = ""; // the file was replaced: start over
        if (first) setStatus(body.omitted ? "Showing the most recent entries; earlier ones are omitted." : body.entries.length ? "" : "This session has no entries yet.", false);
        body.entries.forEach(addEntry);
        while (entriesEl.childNodes.length > MAX_ENTRIES) entriesEl.removeChild(entriesEl.firstChild);
        if (typeof body.next === "number") next = body.next;
        if (body.last_prompt_at) {
          lastPromptAt = body.last_prompt_at;
          renderHeader();
        }
        if (stick && body.entries.length) window.scrollTo(0, document.documentElement.scrollHeight);
      })
      .catch(function () {
        // transient: try again on the next tick
      })
      .then(function () {
        busy = false;
        if (mine === generation) timer = setTimeout(refresh, POLL_MS);
      });
  }

  function show(session) {
    generation++;
    busy = false;
    clearTimeout(timer);
    current = session;
    next = null;
    lastPromptAt = null;
    reported = {};
    entriesEl.textContent = "";
    setStatus(session ? "Loading…" : "No Claude sessions found in ~/.claude/projects.", false);
    renderHeader();
    renderSelect();
    if (session) refresh();
  }

  function loadSessions() {
    return fetch("/api/claude-sessions")
      .then(readJson)
      .then(function (body) {
        sessions = body && Array.isArray(body.sessions) ? body.sessions.filter(function (s) { return s && typeof s.id === "string"; }) : [];
      });
  }

  select.addEventListener("change", function () {
    var picked = sessions.filter(function (s) { return s.id === select.value; })[0];
    if (!picked || (current && picked.id === current.id)) return;
    try {
      history.replaceState(null, "", "?id=" + encodeURIComponent(picked.id));
    } catch (e) {
      // the address bar just keeps the old id
    }
    show(picked);
  });

  var wanted = new URLSearchParams(location.search).get("id");
  loadSessions()
    .then(function () {
      var match = sessions.filter(function (s) { return s.id === wanted; })[0];
      show(match || (wanted && /^[0-9a-f-]{36}$/i.test(wanted) ? { id: wanted.toLowerCase() } : sessions[0] || null));
    })
    .catch(function () {
      sessionIdEl.textContent = "see-plan is not reachable";
      setStatus("Could not load Claude sessions. Is the see-plan server running?", true);
    });

  // Keep the menu's titles and times fresh without moving off the session being read.
  setInterval(function () {
    if (document.hidden || document.activeElement === select) return;
    loadSessions().then(renderSelect).catch(function () {});
  }, LIST_MS);
})();
