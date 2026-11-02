/* see-plan chrome page: conversation panel, prompt queue, send, live events.
 * Classic script (no imports). User-controlled strings (chat text, anchors,
 * queued prompts) are only ever set through textContent; agent entries arrive
 * as server-rendered, escaped Markdown HTML. */
(function () {
  "use strict";

  var SOURCE = "my-lavish";
  var SNAPSHOT_TIMEOUT_MS = 5000;
  var RECONNECT_DELAYS_MS = [1000, 2000, 5000];
  var NOT_LISTENING = "Your agent is not listening. Ask it to run see-plan poll.";
  var ERROR_LOG = "~/claude-errors/error-log.json";
  var LOG_TAG = "claude-log";

  var boot = readBootstrap();
  var key = typeof boot.key === "string" ? boot.key : "";
  var storageKey = "my-lavish:queue:" + key;

  var frame = document.getElementById("artifact");
  var chatLog = document.getElementById("chatLog");
  var queuedLog = document.getElementById("queuedLog");
  var input = document.getElementById("chatInput");
  var sendButton = document.getElementById("send");
  var sendAndEndButton = document.getElementById("sendAndEnd");
  var endButton = document.getElementById("endSession");
  var annotateButton = document.getElementById("annotateToggle");
  var agentStatus = document.getElementById("agentStatus");
  var agentStatusText = document.getElementById("agentStatusText");
  var presenceBanner = document.getElementById("presenceBanner");
  var presenceText = document.getElementById("presenceText");
  var connectButton = document.getElementById("connectClaude");
  var sendHint = document.getElementById("sendHint");
  var endedBanner = document.getElementById("endedBanner");
  var newSessionButton = document.getElementById("newSession");
  var tabChat = document.getElementById("tabChat");
  var tabLog = document.getElementById("tabLog");
  var claudeLog = document.getElementById("claudeLog");
  var claudeHeader = document.getElementById("claudeHeader");
  var claudeCurrent = document.getElementById("claudeCurrent");
  var claudeChange = document.getElementById("claudeChange");
  var claudePicker = document.getElementById("claudePicker");
  var claudeSessions = document.getElementById("claudeSessions");
  var claudeInput = document.getElementById("claudeSessionInput");
  var claudeAttachButton = document.getElementById("claudeAttachButton");
  var claudeStatus = document.getElementById("claudeStatus");
  var claudeEntries = document.getElementById("claudeEntries");
  var LOG_POLL_MS = 2000;
  var MAX_LOG_ENTRIES = 500;

  var queue = loadQueue();
  var ended = false;
  var sending = false;
  var annotate = true; // the SDK reports its real state with a "mode" message
  var frameLoads = 0;
  var lastScroll = null;
  var pendingRestore = null;
  var snapshotWaiters = {};
  var reconnectAttempt = 0;
  var claudeSessionId = typeof boot.claude_session_id === "string" ? boot.claude_session_id : "";
  var logVisible = false;
  var logNext = null; // byte offset to continue from; null means the first (tail) request
  var logTimer = null;
  var logBusy = false;
  var pickerOpen = false; // the recent-sessions list, opened over an attached session
  var logMissing = false; // the attached session has no transcript (yet)
  var sessionsBusy = false;
  var sentLogRefs = {}; // prompt ids of log entries already in the chat
  var agentListening = false;
  var connecting = false;
  var shownRevision = (function () {
    var m = /[?&]rev=(\d+)/.exec(frame ? frame.getAttribute("src") || "" : "");
    return m ? Number(m[1]) : 0;
  })();

  // ---- bootstrap & storage -------------------------------------------------

  function readBootstrap() {
    var el = document.getElementById("my-lavish-session");
    try {
      var data = JSON.parse(el ? el.textContent : "{}");
      return data && typeof data === "object" ? data : {};
    } catch (e) {
      return {};
    }
  }

  function isQueuedPrompt(p) {
    return p && typeof p === "object" && typeof p.prompt_id === "string" && typeof p.prompt === "string";
  }

  function loadQueue() {
    try {
      var saved = JSON.parse(window.sessionStorage.getItem(storageKey) || "[]");
      return Array.isArray(saved) ? saved.filter(isQueuedPrompt) : [];
    } catch (e) {
      return []; // storage unavailable: the queue lives in memory only
    }
  }

  function saveQueue() {
    try {
      if (queue.length) window.sessionStorage.setItem(storageKey, JSON.stringify(queue));
      else window.sessionStorage.removeItem(storageKey);
    } catch (e) {
      // storage unavailable or full: keep the in-memory queue
    }
  }

  function newPromptId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") return window.crypto.randomUUID();
    // Fallback for non-secure contexts, where randomUUID is missing.
    var bytes = window.crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    var hex = Array.prototype.map.call(bytes, function (b) { return (b + 0x100).toString(16).slice(1); }).join("");
    return hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16) + "-" + hex.slice(16, 20) + "-" + hex.slice(20);
  }

  // ---- rendering -----------------------------------------------------------

  function element(tag, className, text) {
    var el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  }

  function anchorLabel(prompt) {
    if (prompt.tag === "text") return "text selection";
    if (prompt.tag === "chat" || !prompt.tag) return "";
    if (prompt.tag === LOG_TAG) return "Claude log entry";
    return prompt.tag + " " + (prompt.selector || "");
  }

  function renderChat(chat) {
    chatLog.textContent = "";
    sentLogRefs = {};
    for (var i = 0; i < chat.length; i++) {
      var entry = chat[i];
      if (!entry || typeof entry !== "object") continue;
      if (typeof entry.prompt_id === "string" && entry.prompt_id.indexOf(LOG_TAG + ":") === 0) sentLogRefs[entry.prompt_id] = true;
      var bubble;
      if (entry.role === "agent") {
        bubble = element("div", "bubble agent");
        bubble.innerHTML = String(entry.html || ""); // server-rendered, escaped Markdown
      } else {
        bubble = element("div", "bubble user");
        if (entry.anchor) bubble.appendChild(element("div", "anchor", String(entry.anchor)));
        bubble.appendChild(element("div", "text", String(entry.text || "")));
      }
      if (entry.at) bubble.title = String(entry.at);
      chatLog.appendChild(bubble);
    }
    chatLog.scrollTop = chatLog.scrollHeight;
    markSentRows();
  }

  function renderQueue() {
    queuedLog.textContent = "";
    queue.forEach(function (item) {
      var bubble = element("div", "bubble queued");
      var head = element("div", "queued-head");
      head.appendChild(element("span", "queued-label", "Queued"));
      var remove = element("button", "remove", "×");
      remove.type = "button";
      remove.title = "Remove from queue";
      remove.setAttribute("aria-label", "Remove from queue");
      remove.disabled = sending || ended;
      remove.addEventListener("click", function () {
        queue = queue.filter(function (q) { return q.prompt_id !== item.prompt_id; });
        saveQueue();
        renderQueue();
      });
      head.appendChild(remove);
      bubble.appendChild(head);
      var anchor = anchorLabel(item);
      if (anchor) bubble.appendChild(element("div", "anchor", anchor));
      if (item.tag === "text" && item.text) bubble.appendChild(element("div", "quote", String(item.text)));
      bubble.appendChild(element("div", "text", item.prompt));
      queuedLog.appendChild(bubble);
    });
    queuedLog.hidden = queue.length === 0 || logVisible;
  }

  function showHint(text, isError) {
    sendHint.textContent = text || "";
    sendHint.classList.toggle("error", Boolean(isError));
  }

  function renderControls() {
    var locked = ended || sending;
    input.disabled = ended;
    sendButton.disabled = locked;
    sendAndEndButton.disabled = locked;
    endButton.disabled = locked;
    annotateButton.disabled = ended;
    annotateButton.setAttribute("aria-pressed", annotate && !ended ? "true" : "false");
    annotateButton.textContent = annotate && !ended ? "Annotate: on" : "Annotate: off";
  }

  /** listening: a poll waits now. working: the last poll took feedback and has not polled again yet. */
  function setPresence(msg) {
    var listening = msg.listening === true;
    var working = !listening && msg.working === true;
    var who = msg.agent === "claude" ? "Claude agent" : "Agent";
    agentListening = listening;
    presenceText.textContent = NOT_LISTENING;
    if (listening) connectButton.disabled = false; // a later drop may need a new launch
    if (listening && connecting) {
      connecting = false;
      showHint("", false);
    }
    presenceBanner.hidden = ended || msg.listening !== false || working;
    var text = listening ? who + " connected — waiting for your feedback" : who + " is working on your feedback";
    if (typeof msg.session_id === "string" && msg.session_id) {
      text += " · session " + msg.session_id.slice(0, 8);
      agentStatus.title = "Claude session " + msg.session_id;
    } else {
      agentStatus.removeAttribute("title");
    }
    agentStatusText.textContent = text;
    agentStatus.classList.toggle("working", working);
    agentStatus.hidden = ended || !(listening || working);
  }

  function connectClaude() {
    connectButton.disabled = true;
    showHint("Starting Claude in a PowerShell window…", false);
    fetch("/api/" + encodeURIComponent(key) + "/connect-claude", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })
      .then(function (res) {
        return readJson(res).then(function (body) {
          if (res.ok) {
            connecting = true;
            showHint("Claude is starting; this banner clears once it begins polling.", false);
          } else {
            connectButton.disabled = false;
            showHint(errorMessage(body, res.status), true);
          }
        });
      })
      .catch(function (e) {
        connectButton.disabled = false;
        showHint("Could not reach see-plan: " + (e && e.message ? e.message : e), true);
      });
  }

  function setEnded() {
    if (ended) return;
    ended = true;
    document.body.classList.add("ended");
    presenceBanner.hidden = true;
    agentStatus.hidden = true;
    showHint("", false);
    endedBanner.hidden = false;
    newSessionButton.hidden = false;
    setFrameMode(false);
    postToFrame({ type: "ended" });
    renderControls();
    renderQueue();
  }

  /** Drops queued prompts that the server has accepted (their id is in the chat). */
  function pruneQueue(chat) {
    var accepted = {};
    chat.forEach(function (entry) {
      if (entry && typeof entry.prompt_id === "string") accepted[entry.prompt_id] = true;
    });
    var before = queue.length;
    queue = queue.filter(function (q) { return !accepted[q.prompt_id]; });
    if (queue.length !== before) {
      saveQueue();
      renderQueue();
    }
  }

  // ---- artifact frame ------------------------------------------------------

  function postToFrame(message) {
    message.source = SOURCE;
    try {
      frame.contentWindow.postMessage(message, "*"); // the sandboxed frame has an opaque origin
    } catch (e) {
      // frame not ready: nothing to do
    }
  }

  function setFrameMode(on) {
    annotate = Boolean(on);
    postToFrame({ type: "setMode", annotate: annotate });
    renderControls();
  }

  function enqueue(raw) {
    if (ended) {
      showHint("Session ended — new notes are not sent.", true);
      return;
    }
    if (!raw || typeof raw !== "object" || typeof raw.prompt !== "string" || !raw.prompt.trim()) return;
    var item = {
      prompt_id: newPromptId(), // always assigned here, never trusted from the frame
      prompt: raw.prompt.trim(),
      tag: typeof raw.tag === "string" ? raw.tag : "",
      selector: typeof raw.selector === "string" ? raw.selector : "",
      text: typeof raw.text === "string" ? raw.text : "",
    };
    if (raw.target && typeof raw.target === "object") {
      try {
        item.target = JSON.parse(JSON.stringify(raw.target));
      } catch (e) {
        // un-serializable target: send the prompt without it
      }
    }
    queue.push(item);
    if (!ended) showHint("", false);
    saveQueue();
    renderQueue();
    queuedLog.scrollTop = queuedLog.scrollHeight;
  }

  function onFrameReady() {
    frameLoads++;
    if (ended) {
      postToFrame({ type: "setMode", annotate: false });
      postToFrame({ type: "ended" });
    }
    else if (frameLoads > 1) postToFrame({ type: "setMode", annotate: annotate }); // keep mode across reloads
    if (pendingRestore) {
      postToFrame({ type: "restoreScroll", x: pendingRestore.x, y: pendingRestore.y });
      pendingRestore = null;
    }
  }

  window.addEventListener("message", function (event) {
    if (!frame || event.source !== frame.contentWindow) return;
    var data = event.data;
    if (!data || typeof data !== "object" || data.source !== SOURCE) return;
    switch (data.type) {
      case "queuePrompt":
        enqueue(data.prompt);
        break;
      case "snapshot":
        if (typeof data.id === "string" && snapshotWaiters[data.id]) snapshotWaiters[data.id](data.html);
        break;
      case "scroll":
        if (isFinite(data.x) && isFinite(data.y)) lastScroll = { x: Number(data.x), y: Number(data.y) };
        break;
      case "mode":
        if (!ended) {
          annotate = Boolean(data.annotate);
          renderControls();
        }
        break;
      case "ready":
        onFrameReady();
        break;
    }
  });

  /** Resolves with the artifact's HTML, or "" if the frame does not answer within 5 s. */
  function requestSnapshot() {
    return new Promise(function (resolve) {
      var id = newPromptId();
      var timer = setTimeout(function () { finish(""); }, SNAPSHOT_TIMEOUT_MS);
      function finish(html) {
        clearTimeout(timer);
        delete snapshotWaiters[id];
        resolve(typeof html === "string" ? html : "");
      }
      snapshotWaiters[id] = finish;
      postToFrame({ type: "requestSnapshot", id: id });
    });
  }

  // ---- sending -------------------------------------------------------------

  function errorMessage(body, status) {
    var err = body && body.error;
    if (err && err.message) return err.message;
    if (err && err.code) return err.code;
    return "Send failed (HTTP " + status + ")";
  }

  function readJson(res) {
    return res.json().catch(function () { return null; });
  }

  function send(end) {
    if (ended || sending) return;
    var typed = input.value.trim();
    if (typed) {
      queue.push({ prompt_id: newPromptId(), prompt: typed, tag: "chat", selector: "", text: "" });
      input.value = "";
      saveQueue();
      renderQueue();
    }
    if (!queue.length && !end) {
      showHint("Nothing to send yet: click the page or type a message.", false);
      return;
    }
    var batch = queue.slice();
    sending = true;
    renderControls();
    renderQueue();
    showHint("Sending…", false);
    requestSnapshot()
      .then(function (snapshot) {
        return fetch("/api/" + encodeURIComponent(key) + "/prompts", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ prompts: batch, dom_snapshot: snapshot, end: Boolean(end) }),
        });
      })
      .then(function (res) {
        return readJson(res).then(function (body) {
          if (res.ok && body && Array.isArray(body.chat)) {
            pruneQueue(body.chat);
            renderChat(body.chat);
            showHint("", false);
            if (end) setEnded();
          } else if (res.status === 409 && body && body.error && body.error.code === "ENDED") {
            setEnded();
          } else {
            showHint(errorMessage(body, res.status), true);
          }
        });
      })
      .catch(function (e) {
        showHint("Could not reach see-plan: " + (e && e.message ? e.message : e), true);
      })
      .then(function () {
        sending = false;
        renderControls();
        renderQueue();
      });
  }

  function endSession() {
    if (ended || sending) return;
    sending = true;
    renderControls();
    fetch("/api/" + encodeURIComponent(key) + "/end", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })
      .then(function (res) {
        return readJson(res).then(function (body) {
          if (res.ok) setEnded();
          else showHint(errorMessage(body, res.status), true);
        });
      })
      .catch(function (e) {
        showHint("Could not reach see-plan: " + (e && e.message ? e.message : e), true);
      })
      .then(function () {
        sending = false;
        renderControls();
      });
  }

  function startNewSession() {
    newSessionButton.disabled = true;
    fetch("/api/" + encodeURIComponent(key) + "/new-session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })
      .then(function (res) {
        return readJson(res).then(function (body) {
          if (res.ok) {
            window.location.reload();
          } else {
            newSessionButton.disabled = false;
            showHint(errorMessage(body, res.status), true);
          }
        });
      })
      .catch(function (e) {
        newSessionButton.disabled = false;
        showHint("Could not reach see-plan: " + (e && e.message ? e.message : e), true);
      });
  }

  // ---- Claude log tab ------------------------------------------------------

  function selectTab(showLog) {
    logVisible = showLog;
    chatLog.hidden = showLog;
    claudeLog.hidden = !showLog;
    if (showLog) queuedLog.hidden = true;
    else renderQueue();
    tabChat.setAttribute("aria-selected", showLog ? "false" : "true");
    tabLog.setAttribute("aria-selected", showLog ? "true" : "false");
    if (showLog) {
      refreshLog();
      if (!claudePicker.hidden) loadSessions();
    } else {
      clearTimeout(logTimer);
    }
  }

  function waitingText() {
    return "Waiting for Claude's log for session " + claudeSessionId + "\u2026";
  }

  function resetLog() {
    logNext = null;
    logMissing = false;
    claudeEntries.textContent = "";
    claudeStatus.textContent = claudeSessionId
      ? waitingText()
      : "No Claude session is attached yet. Pick a recent one, use Connect Claude, or paste a session id.";
    renderPicker();
  }

  /** The list shows while no session is attached, while the attached one has no transcript, or on request. */
  function renderPicker() {
    var show = !claudeSessionId || pickerOpen || logMissing;
    claudeHeader.hidden = !claudeSessionId;
    claudeCurrent.textContent = claudeSessionId ? "Session " + claudeSessionId.slice(0, 8) : "";
    claudeCurrent.title = claudeSessionId;
    claudeChange.textContent = pickerOpen ? "Close list" : "Change session";
    claudeChange.hidden = show && !pickerOpen; // the list is already up on its own
    if (show && claudePicker.hidden && logVisible) loadSessions();
    claudePicker.hidden = !show;
  }

  function timeAgo(iso) {
    var t = Date.parse(iso);
    if (!isFinite(t)) return "";
    var min = Math.round((Date.now() - t) / 60000);
    if (min < 1) return "just now";
    if (min < 60) return min + " min ago";
    if (min < 1440) return Math.round(min / 60) + " h ago";
    if (min < 10080) return Math.round(min / 1440) + " d ago";
    return new Date(t).toLocaleDateString();
  }

  function projectLabel(s) {
    var parts = String(s.cwd || "").split(/[\\/]/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : String(s.project || "");
  }

  function renderSessions(list) {
    claudeSessions.textContent = "";
    if (!list.length) {
      claudeSessions.appendChild(element("p", "picker-empty", "No Claude sessions found in ~/.claude/projects."));
      return;
    }
    list.forEach(function (s) {
      if (!s || typeof s.id !== "string") return;
      var item = element("button", "session-item" + (s.id === claudeSessionId ? " current" : ""));
      item.type = "button";
      item.title = s.id + (s.cwd ? "\n" + String(s.cwd) : "");
      item.appendChild(element("span", "session-title", String(s.title || "(no prompt)")));
      item.appendChild(element("span", "session-meta", [projectLabel(s), timeAgo(s.modified_at), s.id.slice(0, 8)].filter(Boolean).join(" \u00b7 ")));
      item.addEventListener("click", function () { attachClaudeSession(s.id); });
      claudeSessions.appendChild(item);
    });
  }

  function loadSessions() {
    if (sessionsBusy) return;
    sessionsBusy = true;
    if (!claudeSessions.childNodes.length) claudeSessions.appendChild(element("p", "picker-empty", "Loading\u2026"));
    fetch("/api/claude-sessions")
      .then(readJson)
      .then(function (body) {
        renderSessions(body && Array.isArray(body.sessions) ? body.sessions : []);
      })
      .catch(function () {
        claudeSessions.textContent = "";
        claudeSessions.appendChild(element("p", "picker-empty", "Could not load Claude sessions."));
      })
      .then(function () {
        sessionsBusy = false;
      });
  }

  /** The entry's prompt id: stable per transcript line, so a resend is a no-op and marks survive a reload. */
  function logRef(entry) {
    return typeof entry.uuid === "string" ? LOG_TAG + ":" + entry.uuid + ":" + (Number(entry.part) || 0) : "";
  }

  function markSentRows() {
    var rows = claudeEntries.querySelectorAll(".log-entry[data-ref]");
    for (var i = 0; i < rows.length; i++) {
      if (sentLogRefs[rows[i].getAttribute("data-ref")]) rows[i].classList.add("sent");
    }
  }

  function addLogEntry(entry) {
    if (!entry || typeof entry !== "object") return;
    var row = element("div", "log-entry " + String(entry.kind || "text").replace(/[^a-z_]/g, ""));
    var who = entry.role === "assistant" ? "Claude" : "User";
    var kind = entry.kind === "tool_use" ? " \u00b7 tool call" : entry.kind === "tool_result" ? " \u00b7 tool result" : "";
    row.appendChild(element("div", "log-label", who + kind));
    row.appendChild(element("div", "log-text", String(entry.text || ""))); // textContent only: tool output is untrusted
    row.tabIndex = 0;
    row.setAttribute("role", "button");
    row.title = (entry.at ? String(entry.at) + "\n" : "") + "Click to send this entry to the agent for " + ERROR_LOG;
    var ref = logRef(entry);
    if (ref) {
      row.setAttribute("data-ref", ref);
      if (sentLogRefs[ref]) row.classList.add("sent");
    }
    row.addEventListener("click", function () {
      var selection = window.getSelection ? window.getSelection() : null;
      if (selection && !selection.isCollapsed && row.contains(selection.anchorNode)) return; // copying text, not picking
      sendLogEntry(entry, row);
    });
    row.addEventListener("keydown", function (event) {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        sendLogEntry(entry, row);
      }
    });
    claudeEntries.appendChild(row);
  }

  /** Sends one log entry as a claude-log prompt; poll's next_step tells the agent to append it to ERROR_LOG. */
  function sendLogEntry(entry, row) {
    if (ended) {
      showHint("Session ended \u2014 log entries are not sent.", true);
      return;
    }
    if (row.classList.contains("sent")) {
      showHint("That entry was already sent to the agent.", false);
      return;
    }
    if (row.classList.contains("sending")) return;
    row.classList.add("sending");
    var delivered = agentListening; // read now: the poll answers, and drops presence, before this POST does
    var prompt = {
      prompt_id: logRef(entry) || newPromptId(),
      prompt: "Add this Claude log entry to " + ERROR_LOG + ".",
      tag: LOG_TAG,
      selector: "",
      text: "",
      target: {
        error_log: ERROR_LOG,
        entry: {
          claude_session_id: claudeSessionId,
          uuid: typeof entry.uuid === "string" ? entry.uuid : null,
          part: Number(entry.part) || 0,
          role: String(entry.role || ""),
          kind: String(entry.kind || ""),
          at: entry.at ? String(entry.at) : null,
          text: String(entry.text || ""),
        },
      },
    };
    fetch("/api/" + encodeURIComponent(key) + "/prompts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompts: [prompt], dom_snapshot: "" }),
    })
      .then(function (res) {
        return readJson(res).then(function (body) {
          if (res.ok && body && Array.isArray(body.chat)) {
            row.classList.add("sent");
            renderChat(body.chat);
            showHint(delivered
              ? "Sent to the agent for " + ERROR_LOG + "."
              : "Queued for the agent; it gets the entry when it polls.", false);
          } else if (res.status === 409 && body && body.error && body.error.code === "ENDED") {
            setEnded();
          } else {
            showHint(errorMessage(body, res.status), true);
          }
        });
      })
      .catch(function (e) {
        showHint("Could not reach see-plan: " + (e && e.message ? e.message : e), true);
      })
      .then(function () {
        row.classList.remove("sending");
      });
  }

  function refreshLog() {
    clearTimeout(logTimer);
    if (!logVisible || logBusy) return;
    if (!claudeSessionId) return;
    logBusy = true;
    var url = "/api/" + encodeURIComponent(key) + "/claude-log" + (logNext === null ? "" : "?after=" + logNext);
    fetch(url)
      .then(readJson)
      .then(function (body) {
        if (!body || !Array.isArray(body.entries)) return;
        if (logMissing !== !body.found) {
          logMissing = !body.found;
          renderPicker();
        }
        if (!body.found) {
          claudeStatus.textContent = waitingText() + " Or pick another session below.";
          return;
        }
        var first = logNext === null;
        if (body.omitted && !first) claudeEntries.textContent = ""; // the file was replaced: start over
        if (body.omitted) claudeStatus.textContent = "Earlier entries omitted";
        else if (first) claudeStatus.textContent = body.entries.length ? "" : "Claude has not written anything yet.";
        else if (body.entries.length) claudeStatus.textContent = "";
        body.entries.forEach(addLogEntry);
        while (claudeEntries.childNodes.length > MAX_LOG_ENTRIES) claudeEntries.removeChild(claudeEntries.firstChild);
        if (typeof body.next === "number") logNext = body.next;
        if (body.entries.length && !pickerOpen) claudeLog.scrollTop = claudeLog.scrollHeight;
      })
      .catch(function () {
        // transient: try again on the next tick
      })
      .then(function () {
        logBusy = false;
        if (logVisible) logTimer = setTimeout(refreshLog, LOG_POLL_MS);
      });
  }

  function onClaudeSession(id) {
    if (id === claudeSessionId) { // e.g. our own attach echoed back over the WebSocket
      renderPicker();
      return;
    }
    claudeSessionId = id;
    resetLog();
    if (logVisible) refreshLog();
  }

  function attachClaudeSession(id) {
    if (!id) return;
    claudeAttachButton.disabled = true;
    fetch("/api/" + encodeURIComponent(key) + "/claude-session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: id }),
    })
      .then(function (res) {
        return readJson(res).then(function (body) {
          if (res.ok) {
            claudeInput.value = "";
            pickerOpen = false;
            onClaudeSession(id);
          } else {
            claudeStatus.textContent = errorMessage(body, res.status);
          }
        });
      })
      .catch(function (e) {
        claudeStatus.textContent = "Could not reach see-plan: " + (e && e.message ? e.message : e);
      })
      .then(function () {
        claudeAttachButton.disabled = false;
      });
  }

  // ---- live events ---------------------------------------------------------

  function onServerEvent(msg) {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "chat" && Array.isArray(msg.chat)) {
      renderChat(msg.chat);
      pruneQueue(msg.chat);
    } else if (msg.type === "presence") {
      setPresence(msg);
    } else if (msg.type === "reload" || (msg.type === "revision" && Number(msg.revision) !== shownRevision)) {
      // "revision" is sent on every (re)connect: it catches reloads missed while the socket was down.
      shownRevision = Number(msg.revision);
      pendingRestore = lastScroll;
      frame.src = "/artifact/" + encodeURIComponent(key) + "/index.html?rev=" + encodeURIComponent(String(msg.revision));
    } else if (msg.type === "ended") {
      setEnded();
    } else if (msg.type === "claude-session" && typeof msg.id === "string") {
      onClaudeSession(msg.id);
    } else if (msg.type === "new-session") {
      window.location.reload();
    }
  }

  function connect() {
    var protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    var ws;
    try {
      ws = new WebSocket(protocol + "//" + window.location.host + "/events/" + encodeURIComponent(key));
    } catch (e) {
      scheduleReconnect();
      return;
    }
    ws.addEventListener("open", function () {
      reconnectAttempt = 0;
    });
    ws.addEventListener("message", function (event) {
      var msg;
      try {
        msg = JSON.parse(event.data);
      } catch (e) {
        return;
      }
      onServerEvent(msg);
    });
    ws.addEventListener("close", scheduleReconnect);
  }

  function scheduleReconnect() {
    var delay = RECONNECT_DELAYS_MS[Math.min(reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
    reconnectAttempt++;
    setTimeout(connect, delay);
  }

  // ---- controls ------------------------------------------------------------

  function toggleAnnotate() {
    if (!ended) setFrameMode(!annotate);
  }

  input.addEventListener("keydown", function (event) {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      send(false);
    }
  });
  sendButton.addEventListener("click", function () { send(false); });
  sendAndEndButton.addEventListener("click", function () { send(true); });
  endButton.addEventListener("click", endSession);
  newSessionButton.addEventListener("click", startNewSession);
  connectButton.addEventListener("click", connectClaude);
  tabChat.addEventListener("click", function () { selectTab(false); });
  tabLog.addEventListener("click", function () { selectTab(true); });
  claudeAttachButton.addEventListener("click", function () { attachClaudeSession(claudeInput.value.trim()); });
  claudeInput.addEventListener("keydown", function (event) {
    if (event.key === "Enter") {
      event.preventDefault();
      attachClaudeSession(claudeInput.value.trim());
    }
  });
  claudeChange.addEventListener("click", function () {
    pickerOpen = !pickerOpen;
    renderPicker();
    claudeLog.scrollTop = pickerOpen ? 0 : claudeLog.scrollHeight;
  });
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) clearTimeout(logTimer);
    else if (logVisible) refreshLog();
  });
  if (claudeSessionId) selectTab(true); // an attached session: show its input/output first
  annotateButton.addEventListener("click", toggleAnnotate);
  document.addEventListener("keydown", function (event) {
    if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey
        && (event.key === "i" || event.key === "I")) {
      event.preventDefault();
      toggleAnnotate();
    }
  });

  renderChat(Array.isArray(boot.chat) ? boot.chat : []);
  renderQueue();
  renderControls();
  resetLog();
  if (boot.status === "ended") setEnded();
  connect();
})();
