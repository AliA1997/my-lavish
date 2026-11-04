/* see-plan Claude log page: shows one Claude session's transcript; a click opens a dialog that logs an entry as an error. */
(function () {
  "use strict";

  var ERROR_LOG = "~/claude-errors/error-log.json";
  var POLL_MS = 2000;
  var LIST_MS = 30000;
  var MAX_ENTRIES = 1000;
  var MAX_REASON = 2000;
  var PREVIEW_CHARS = 300;
  // A copy of src/severity.js (plain data): the page has no module loader.
  var SEVERITIES = ["low", "medium", "high", "send_to_it"];
  var SEVERITY_TITLES = { low: "Low", medium: "Medium", high: "High", send_to_it: "Send to IT" };
  var REASON_REQUIRED = ["high", "send_to_it"];
  var REASON_OPTIONAL_LABEL = "Why is this an error? (optional)";
  var REASON_REQUIRED_LABEL = "Why is this an error? (required for High and Send to IT)";

  var sessionIdEl = document.getElementById("sessionId");
  var lastPromptEl = document.getElementById("lastPrompt");
  var projectEl = document.getElementById("project");
  var select = document.getElementById("sessionSelect");
  var statusEl = document.getElementById("status");
  var entriesEl = document.getElementById("entries");
  var dialog = document.getElementById("logDialog");
  var dialogTitle = document.getElementById("logDialogTitle");
  var previewMeta = document.getElementById("logPreviewMeta");
  var preview = document.getElementById("logPreview");
  var reasonEl = document.getElementById("logReason");
  var dialogHint = document.getElementById("logDialogHint");
  var cancelButton = document.getElementById("logCancel");
  var confirmButton = document.getElementById("logConfirm");
  var severityFieldset = document.getElementById("logSeverity");
  var severityInputs = Array.prototype.slice.call(severityFieldset.querySelectorAll("input[type=radio]"));
  var savedSeverityEl = document.getElementById("logSavedSeverity");
  var reasonLabel = document.getElementById("logReasonLabel");

  var sessions = [];
  var current = null; // { id, modified_at, cwd, project }
  var next = null; // byte offset for the next read, null = start from the tail
  var lastPromptAt = null;
  var reported = {}; // "<uuid>:<part>" -> true
  var reasons = {}; // "<uuid>:<part>" -> the reason saved with it
  var severities = {}; // "<uuid>:<part>" -> the severity saved with it
  var pending = null; // { entry, row, sessionId, logged } while the dialog is open
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
    label.appendChild(element("span", "who", roleLabel(entry)));
    if (entry.at) label.appendChild(element("time", "at", formatTime(entry.at)));
    row.appendChild(label);
    row.appendChild(element("div", "text", String(entry.text || "")));
    var ref = refOf(entry);
    if (ref) {
      row.tabIndex = 0;
      row.setAttribute("role", "button");
      row.title = (entry.at ? formatDate(entry.at) + "\n" : "") + "Click to log this entry as an error in " + ERROR_LOG;
      if (reported[ref]) {
        row.classList.add("logged");
        label.appendChild(severityBadge(severities[ref]));
      }
      row.addEventListener("click", function () {
        var selection = window.getSelection ? window.getSelection() : null;
        if (selection && !selection.isCollapsed && row.contains(selection.anchorNode)) return; // copying text
        openDialog(entry, row);
      });
      row.addEventListener("keydown", function (event) {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          openDialog(entry, row);
        }
      });
    }
    entriesEl.appendChild(row);
  }

  function isSeverity(v) {
    return typeof v === "string" && SEVERITIES.indexOf(v) !== -1;
  }

  /** A severity badge: always the text label, never color alone. */
  function severityBadge(severity) {
    var id = isSeverity(severity) ? severity : "unrated";
    return element("span", "sev-badge sev-" + id, isSeverity(severity) ? SEVERITY_TITLES[severity] : "Unrated");
  }

  function markLogged(row, ref) {
    row.classList.add("logged");
    var label = row.querySelector(".label");
    if (!label) return;
    var old = label.querySelector(".sev-badge");
    if (old) label.removeChild(old);
    label.appendChild(severityBadge(severities[ref]));
  }

  function pickedSeverity() {
    for (var i = 0; i < severityInputs.length; i++) if (severityInputs[i].checked) return severityInputs[i].value;
    return null;
  }

  function needsReason(severity) {
    return REASON_REQUIRED.indexOf(severity) !== -1;
  }

  /** Log as error waits for a severity, and for a reason when High or Send to IT is picked. */
  function updateConfirm() {
    var severity = pickedSeverity();
    var required = needsReason(severity);
    reasonLabel.textContent = required ? REASON_REQUIRED_LABEL : REASON_OPTIONAL_LABEL;
    reasonEl.required = required;
    confirmButton.disabled = !severity || (required && !reasonEl.value.trim());
  }

  severityInputs.forEach(function (input) { input.addEventListener("change", updateConfirm); });
  reasonEl.addEventListener("input", updateConfirm);

  function roleLabel(entry) {
    var kind = entry.kind === "tool_use" ? " · tool call" : entry.kind === "tool_result" ? " · tool result" : "";
    return (entry.role === "assistant" ? "Claude" : "User") + kind;
  }

  /** Opens the confirmation; every text here is set with textContent, as the entry and the reason are untrusted. */
  function openDialog(entry, row) {
    if (!current || row.classList.contains("saving")) return;
    var ref = refOf(entry);
    var logged = Boolean(reported[ref]);
    pending = { entry: entry, row: row, sessionId: current.id, logged: logged };
    dialogTitle.textContent = logged ? "Already in the error log" : "Log as error";
    previewMeta.textContent = [roleLabel(entry), entry.at ? formatDate(entry.at) : ""].filter(Boolean).join(" · ");
    preview.textContent = clip(entry.text, PREVIEW_CHARS);
    reasonEl.value = logged ? reasons[ref] || "" : "";
    reasonEl.readOnly = logged;
    severityInputs.forEach(function (input) { input.checked = false; });
    severityFieldset.hidden = logged;
    savedSeverityEl.hidden = !logged;
    savedSeverityEl.textContent = "";
    if (logged) {
      savedSeverityEl.appendChild(document.createTextNode("Severity: "));
      savedSeverityEl.appendChild(severityBadge(severities[ref]));
    }
    updateConfirm();
    reasonEl.placeholder = logged ? "No reason was given." : "What went wrong here?";
    confirmButton.hidden = logged;
    cancelButton.textContent = logged ? "Close" : "Cancel";
    dialogHint.textContent = logged ? "Reasons and severities can't be edited here. Esc to close." : "1–4 picks a severity · Ctrl+Enter to log · Esc to cancel";
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    (logged ? cancelButton : severityInputs[0]).focus();
  }

  function closeDialog() {
    if (typeof dialog.close === "function") dialog.close();
    else dialog.removeAttribute("open");
  }

  // However the dialog closes (Esc, Cancel, after logging), focus goes back to the entry.
  dialog.addEventListener("close", function () {
    var row = pending && pending.row;
    pending = null;
    if (row && row.isConnected) row.focus();
  });

  cancelButton.addEventListener("click", closeDialog);

  dialog.addEventListener("submit", function (event) {
    event.preventDefault();
    confirmLog();
  });

  dialog.addEventListener("keydown", function (event) {
    var digit = /^[1-4]$/.test(event.key) && !event.ctrlKey && !event.metaKey && !event.altKey;
    if (digit && pending && !pending.logged && event.target !== reasonEl) {
      event.preventDefault();
      var input = severityInputs[Number(event.key) - 1];
      input.checked = true;
      input.focus();
      updateConfirm();
      return;
    }
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      confirmLog();
    }
  });

  function confirmLog() {
    if (!pending || pending.logged) return;
    var entry = pending.entry;
    var row = pending.row;
    var sessionId = pending.sessionId;
    var reason = reasonEl.value.trim().slice(0, MAX_REASON);
    var severity = pickedSeverity();
    if (!severity || (needsReason(severity) && !reason)) {
      updateConfirm();
      (severity ? reasonEl : severityInputs[0]).focus();
      return;
    }
    closeDialog();
    if (row.classList.contains("saving")) return;
    row.classList.add("saving");
    fetch("/api/claude-errors", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        entry: {
          claude_session_id: sessionId,
          uuid: entry.uuid,
          part: Number(entry.part) || 0,
          role: String(entry.role || ""),
          kind: String(entry.kind || ""),
          at: entry.at ? String(entry.at) : null,
          text: String(entry.text || ""),
          reason: reason || null,
          severity: severity,
        },
      }),
    })
      .then(function (res) {
        return readJson(res).then(function (body) {
          if (res.ok) {
            var ref = refOf(entry);
            if (current && current.id === sessionId) {
              reported[ref] = true;
              if (body && typeof body.reason === "string" && body.reason) reasons[ref] = body.reason;
              severities[ref] = body && isSeverity(body.severity) ? body.severity : severity;
            }
            markLogged(row, ref);
            setStatus(body && body.duplicate
              ? "Already in " + ERROR_LOG + "; the first reason and severity were kept."
              : "Added to " + ERROR_LOG + " as " + SEVERITY_TITLES[severity] + (reason ? ", with your reason." : "."), false);
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
        if (body.severities && typeof body.severities === "object") {
          Object.keys(body.severities).forEach(function (ref) {
            if (isSeverity(body.severities[ref])) severities[ref] = body.severities[ref];
          });
        }
        if (body.reasons && typeof body.reasons === "object") {
          Object.keys(body.reasons).forEach(function (ref) {
            if (typeof body.reasons[ref] === "string") reasons[ref] = body.reasons[ref];
          });
        }
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
    reasons = {};
    severities = {};
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
