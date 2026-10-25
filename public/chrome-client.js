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
  var presenceBanner = document.getElementById("presenceBanner");
  var sendHint = document.getElementById("sendHint");
  var endedBanner = document.getElementById("endedBanner");
  var newSessionButton = document.getElementById("newSession");

  var queue = loadQueue();
  var ended = false;
  var sending = false;
  var annotate = true; // the SDK reports its real state with a "mode" message
  var frameLoads = 0;
  var lastScroll = null;
  var pendingRestore = null;
  var snapshotWaiters = {};
  var reconnectAttempt = 0;
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
    return prompt.tag + " " + (prompt.selector || "");
  }

  function renderChat(chat) {
    chatLog.textContent = "";
    for (var i = 0; i < chat.length; i++) {
      var entry = chat[i];
      if (!entry || typeof entry !== "object") continue;
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
    queuedLog.hidden = queue.length === 0;
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

  function setPresence(listening) {
    presenceBanner.textContent = NOT_LISTENING;
    presenceBanner.hidden = ended || listening !== false;
  }

  function setEnded() {
    if (ended) return;
    ended = true;
    document.body.classList.add("ended");
    presenceBanner.hidden = true;
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

  // ---- live events ---------------------------------------------------------

  function onServerEvent(msg) {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "chat" && Array.isArray(msg.chat)) {
      renderChat(msg.chat);
      pruneQueue(msg.chat);
    } else if (msg.type === "presence") {
      setPresence(msg.listening);
    } else if (msg.type === "reload" || (msg.type === "revision" && Number(msg.revision) !== shownRevision)) {
      // "revision" is sent on every (re)connect: it catches reloads missed while the socket was down.
      shownRevision = Number(msg.revision);
      pendingRestore = lastScroll;
      frame.src = "/artifact/" + encodeURIComponent(key) + "/index.html?rev=" + encodeURIComponent(String(msg.revision));
    } else if (msg.type === "ended") {
      setEnded();
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
  if (boot.status === "ended") setEnded();
  connect();
})();
