/* see-plan chrome page: conversation panel, prompt queue, send, live events.
 * Classic script (no imports). User-controlled strings (chat text, anchors,
 * queued prompts, feedback, log text) are only ever set through textContent;
 * agent entries arrive as server-rendered, escaped Markdown HTML. */
(function () {
  "use strict";

  var SOURCE = "my-lavish";
  var SNAPSHOT_TIMEOUT_MS = 5000;
  var RECONNECT_DELAYS_MS = [1000, 2000, 5000];
  var STUCK_AFTER_MS = 45000; // a launched Claude that has not polled by now needs the user's help
  var ERROR_LOG = "~/claude-errors/error-log.json";
  var LOG_TAG = "claude-log";
  var ALLOW_RULE = '"Bash(see-plan:*)"';
  var STAGES = ["plan", "interrogation", "implementation", "verification"];
  var STAGE_TITLES = { plan: "Plan", interrogation: "Interrogation", implementation: "Implementation", verification: "Verification" };
  var LOG_POLL_MS = 2000;
  var MAX_LOG_ENTRIES = 500;
  var HIGHLIGHT_LIMIT = 20;

  var boot = readBootstrap();
  var key = typeof boot.key === "string" ? boot.key : "";
  var storageKey = "my-lavish:queue:" + key;

  function $(id) { return document.getElementById(id); }

  var frame = $("artifact");
  var chatLog = $("chatLog");
  var queuedLog = $("queuedLog");
  var input = $("chatInput");
  var sendButton = $("send");
  var sendAndEndButton = $("sendAndEnd");
  var endButton = $("endSession");
  var commentPlanButton = $("commentPlan");
  var moreButton = $("moreButton");
  var moreMenu = $("moreMenu");
  var annotateButton = $("annotateToggle");
  var sendHint = $("sendHint");
  var endedBanner = $("endedBanner");
  var endedText = $("endedText");
  var resumeSessionButton = $("resumeSession");
  var newSessionButton = $("newSession");
  var connection = $("connection");
  var connectionLabel = $("connectionLabel");
  var connectionText = $("connectionText");
  var connectButton = $("connectClaude");
  var resumeClaudeButton = $("resumeClaude");
  var cancelConnectButton = $("cancelConnect");
  var retryConnectButton = $("retryConnect");
  var copyAllowButton = $("copyAllow");
  var copyCommandButton = $("copyCommand");
  var viewLogButton = $("viewLog");
  var sessionFeedbackButton = $("sessionFeedback");
  var commandBox = $("commandBox");
  var manualConnect = $("manualConnect");
  var pollCommand = $("pollCommand");
  var copyPollButton = $("copyPoll");
  var stageSelect = $("stageSelect");
  var stageInferred = $("stageInferred");
  var stageConfirm = $("stageConfirm");
  var revisionButton = $("revisionButton");
  var revisionMenu = $("revisionMenu");
  var revisionBar = $("revisionBar");
  var revisionBarText = $("revisionBarText");
  var backToLatest = $("backToLatest");
  var workflowBar = $("workflowBar");
  var stageTrack = $("stageTrack");
  var skipStageButton = $("skipStage");
  var nextStageBox = $("nextStage");
  var nextStageText = $("nextStageText");
  var nextStageGo = $("nextStageGo");
  var decisionBar = $("decisionBar");
  var approveButton = $("approve");
  var requestChangesButton = $("requestChanges");
  var previousRounds = $("previousRounds");
  var roundCount = $("roundCount");
  var roundsLog = $("roundsLog");
  var tabChat = $("tabChat");
  var tabLog = $("tabLog");
  var chatPanel = $("chatPanel");
  var claudeLog = $("claudeLog");
  var claudeHeader = $("claudeHeader");
  var claudeCurrent = $("claudeCurrent");
  var claudeChange = $("claudeChange");
  var claudePicker = $("claudePicker");
  var claudeSessions = $("claudeSessions");
  var claudeInput = $("claudeSessionInput");
  var claudeAttachButton = $("claudeAttachButton");
  var claudeStatus = $("claudeStatus");
  var claudeEntries = $("claudeEntries");
  var logPopover = $("logPopover");
  var logNote = $("logNote");
  var confirmDialog = $("confirmDialog");
  var decisionDialog = $("decisionDialog");
  var feedbackDialog = $("feedbackDialog");

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
  var canResume = boot.can_resume === true;
  var logVisible = false;
  var logNext = null; // byte offset to continue from; null means the first (tail) request
  var logTimer = null;
  var logBusy = false;
  var pickerOpen = false;
  var logMissing = false;
  var sessionsBusy = false;
  var sentLogRefs = {};
  var presence = { listening: false, working: false, agent: null, session_id: null, last_poll_at: null };
  var launch = null; // { at, mode, command }: a Connect Claude launch waiting for its first poll
  var launchTimer = null;
  var claudeInfo = null; // GET /api/claude-status
  var stage = boot.stage || "";
  var stageSource = boot.stage_source || "";
  var workflow = boot.workflow && typeof boot.workflow === "object" ? boot.workflow : null;
  var latestRevision = Number(boot.revision) || 0;
  var viewingRevision = null; // a read-only older revision shown in the frame
  var shownRevision = (function () {
    var m = /[?&]rev=(\d+)/.exec(frame ? frame.getAttribute("src") || "" : "");
    return m ? Number(m[1]) : 0;
  })();
  var currentSnapshot = ""; // the frame's DOM, refreshed on each load: the "before" of a change highlight
  var previousSnapshot = null;
  var nextStageAction = null;
  var popoverEntry = null;
  var popoverRow = null;

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

  // localStorage: unsent notes survive closing the tab; cleared once the server accepts them.
  function loadQueue() {
    try {
      var saved = JSON.parse(window.localStorage.getItem(storageKey) || "[]");
      return Array.isArray(saved) ? saved.filter(isQueuedPrompt) : [];
    } catch (e) {
      return [];
    }
  }

  function saveQueue() {
    try {
      if (queue.length) window.localStorage.setItem(storageKey, JSON.stringify(queue));
      else window.localStorage.removeItem(storageKey);
    } catch (e) {
      // storage unavailable or full: keep the in-memory queue
    }
  }

  function newPromptId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") return window.crypto.randomUUID();
    var bytes = window.crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    var hex = Array.prototype.map.call(bytes, function (b) { return (b + 0x100).toString(16).slice(1); }).join("");
    return hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16) + "-" + hex.slice(16, 20) + "-" + hex.slice(20);
  }

  function api(path, body) {
    return fetch("/api/" + encodeURIComponent(key) + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body || {}),
    }).then(function (res) {
      return readJson(res).then(function (json) { return { ok: res.ok, status: res.status, body: json }; });
    });
  }

  function copyText(text, label) {
    function done() { showHint((label || "Copied") + ".", false); }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { showHint("Copy failed; select the text and copy it.", true); });
    } else {
      showHint("Copy is not available here; select the text and copy it.", true);
    }
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
    if (prompt.tag === "plan") return "Whole plan";
    return prompt.tag + " " + (prompt.selector || "");
  }

  function renderBubbles(container, chat) {
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
      container.appendChild(bubble);
    }
  }

  function renderChat(chat) {
    chatLog.textContent = "";
    sentLogRefs = {};
    chat.forEach(function (entry) {
      if (entry && typeof entry.prompt_id === "string" && entry.prompt_id.indexOf(LOG_TAG + ":") === 0) sentLogRefs[entry.prompt_id] = true;
    });
    if (!chat.length && !ended) {
      var tip = element("div", "first-run");
      tip.appendChild(element("p", "", "Click any part of the plan to leave a note, or select text and press Comment."));
      tip.appendChild(element("p", "", "Notes wait above the tabs until you press Send to Agent. Ctrl+I turns annotate mode on and off."));
      chatLog.appendChild(tip);
    }
    renderBubbles(chatLog, chat);
    chatLog.scrollTop = chatLog.scrollHeight;
    markSentRows();
  }

  function renderHistory() {
    var rounds = Array.isArray(boot.history) ? boot.history : [];
    previousRounds.hidden = rounds.length === 0;
    roundCount.textContent = String(rounds.length);
    roundsLog.textContent = "";
    rounds.forEach(function (round, i) {
      var head = element("p", "round-head", "Round " + (i + 1) + (round.ended_at ? " · ended " + new Date(round.ended_at).toLocaleString() : ""));
      roundsLog.appendChild(head);
      renderBubbles(roundsLog, Array.isArray(round.chat) ? round.chat : []);
    });
  }

  function renderQueue() {
    queuedLog.textContent = "";
    if (queue.length) queuedLog.appendChild(element("p", "queued-title", queue.length + (queue.length === 1 ? " note" : " notes") + " not sent yet"));
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
    queuedLog.hidden = queue.length === 0; // shown on both tabs
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
    commentPlanButton.disabled = ended;
    moreButton.disabled = ended;
    annotateButton.disabled = ended;
    annotateButton.setAttribute("aria-pressed", annotate && !ended ? "true" : "false");
    annotateButton.textContent = annotate && !ended ? "Annotate: on" : "Annotate: off";
    approveButton.disabled = locked;
    requestChangesButton.disabled = locked;
  }

  // ---- connection card -----------------------------------------------------

  function connectionState() {
    if (presence.listening) return "connected"; // also during a silent 1:50 reconnect (cycling)
    if (presence.working) return "working";
    if (launch && launch.mode === "copy") return "unsupported";
    if (launch) return Date.now() - launch.at >= STUCK_AFTER_MS ? "stuck" : "starting";
    if (claudeInfo && (claudeInfo.launch === "copy" || claudeInfo.claude_found === false)) return "unsupported";
    return "idle";
  }

  function clock(ms) {
    var s = Math.max(0, Math.floor(ms / 1000));
    return Math.floor(s / 60) + ":" + (s % 60 < 10 ? "0" : "") + (s % 60);
  }

  function show(button, on) { button.hidden = !on; }

  function renderConnection() {
    var state = ended ? "ended" : connectionState();
    connection.setAttribute("data-state", state);
    connection.hidden = ended;
    var who = presence.agent === "claude" ? "Claude" : "Agent";
    var text = "";
    var sid = typeof presence.session_id === "string" && presence.session_id ? " · session " + presence.session_id.slice(0, 8) : "";
    if (state === "connected") text = who + " connected — waiting for your feedback" + sid;
    else if (state === "working") text = who + " is working on your feedback" + sid;
    else if (state === "starting") text = "Starting Claude… " + clock(Date.now() - launch.at);
    else if (state === "stuck") text = "Claude hasn't started polling. Check the Claude window: it may be asking to trust this folder, to log in, or to allow see-plan.";
    else if (state === "unsupported") {
      text = claudeInfo && claudeInfo.claude_found === false && !(launch && launch.command)
        ? "Claude Code was not found on this computer. Install it, or connect an agent manually below."
        : "Can't open a terminal here. Run this in your terminal:";
    } else text = "No agent connected.";
    connectionLabel.textContent = text;
    if (presence.last_poll_at && (state === "connected" || state === "working")) {
      connectionText.title = "Last check-in " + clock(Date.now() - Date.parse(presence.last_poll_at)) + " ago";
    } else {
      connectionText.removeAttribute("title");
    }
    var command = launch && launch.command ? launch.command : "";
    show(connectButton, state === "idle" || (state === "unsupported" && !command && !(claudeInfo && claudeInfo.claude_found === false)));
    connectButton.textContent = state === "unsupported" ? "Get the command" : "Connect Claude";
    show(resumeClaudeButton, state === "idle" && canResume);
    show(cancelConnectButton, state === "starting");
    show(retryConnectButton, state === "stuck");
    show(copyAllowButton, state === "stuck");
    show(copyCommandButton, (state === "stuck" || state === "unsupported") && Boolean(command));
    show(viewLogButton, (state === "connected" || state === "working") && Boolean(claudeSessionId));
    commandBox.hidden = !(state === "unsupported" && command);
    commandBox.textContent = command;
    manualConnect.hidden = state === "connected" || state === "working";
    sendSessionFeedbackVisibility();
  }

  function sendSessionFeedbackVisibility() {
    sessionFeedbackButton.hidden = ended;
  }

  function setPresence(msg) {
    presence = {
      listening: msg.listening === true,
      working: msg.listening !== true && msg.working === true,
      agent: msg.agent || null,
      session_id: msg.session_id || null,
      last_poll_at: msg.last_poll_at || null,
    };
    if (presence.listening || presence.working) stopLaunch();
    renderConnection();
  }

  function stopLaunch() {
    launch = null;
    clearInterval(launchTimer);
    launchTimer = null;
  }

  function startLaunchClock(mode, command) {
    launch = { at: Date.now(), mode: mode, command: command || "" };
    clearInterval(launchTimer);
    if (mode !== "copy") {
      launchTimer = setInterval(function () {
        if (!launch) return stopLaunch();
        renderConnection();
        if (Date.now() - launch.at > STUCK_AFTER_MS + 1000) {
          clearInterval(launchTimer);
          launchTimer = null;
        }
      }, 1000);
    }
    renderConnection();
  }

  function connectClaude(resume, targetKey) {
    var path = "/api/" + encodeURIComponent(targetKey || key) + "/connect-claude";
    connectButton.disabled = true;
    resumeClaudeButton.disabled = true;
    retryConnectButton.disabled = true;
    return fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(resume ? { resume: true } : {}) })
      .then(function (res) {
        return readJson(res).then(function (body) {
          if (!res.ok) {
            var code = body && body.error && body.error.code;
            if (code === "AGENT_RECONNECTING" || code === "LISTENER_ACTIVE") {
              showHint("An agent is already connected.", false);
            } else {
              showHint(errorMessage(body, res.status), true);
            }
            return false;
          }
          if (!targetKey || targetKey === key) {
            if (body.claude_session_id) onClaudeSession(body.claude_session_id);
            startLaunchClock(body.mode || "powershell", body.command);
          }
          return true;
        });
      })
      .catch(function (e) {
        showHint("Could not reach see-plan: " + (e && e.message ? e.message : e), true);
        return false;
      })
      .then(function (ok) {
        connectButton.disabled = false;
        resumeClaudeButton.disabled = false;
        retryConnectButton.disabled = false;
        return ok;
      });
  }

  function cancelConnect() {
    stopLaunch();
    api("/connect-cancel", {}).catch(function () {});
    renderConnection();
  }

  function loadClaudeStatus() {
    fetch("/api/claude-status")
      .then(readJson)
      .then(function (body) {
        if (body && typeof body.launch === "string") {
          claudeInfo = body;
          renderConnection();
        }
      })
      .catch(function () {});
  }

  // ---- stage label ---------------------------------------------------------

  function renderStage() {
    stageSelect.value = stage || "";
    var inferred = Boolean(stage) && (stageSource === "text" || stageSource === "path" || stageSource === "workflow");
    stageInferred.hidden = !inferred;
    stageSelect.disabled = ended;
    var title = STAGE_TITLES[stage];
    approveButton.textContent = stage === "verification" ? "Accept" : "Approve " + (title ? title.toLowerCase() : "plan");
    decisionBar.hidden = ended || !(boot.has_plan || stage);
    pollCommand.textContent = String(boot.poll_command || "see-plan poll <file>");
  }

  function setStage(next) {
    api("/stage", { stage: next || null }).then(function (r) {
      if (r.ok && r.body) {
        stage = r.body.stage || "";
        stageSource = r.body.stage_source || "";
        renderStage();
      } else {
        showHint(errorMessage(r.body, r.status), true);
        renderStage();
      }
    }, function () { showHint("Could not reach see-plan.", true); });
  }

  // ---- workflow -----------------------------------------------------------

  function renderWorkflow() {
    workflowBar.hidden = !workflow;
    if (!workflow) return;
    stageTrack.textContent = "";
    STAGES.forEach(function (s, i) {
      var info = workflow.stages && workflow.stages[s] ? workflow.stages[s] : { status: "locked" };
      var li = element("li", "track-" + String(info.status).replace(/[^a-z]/g, "") + (s === stage ? " here" : ""));
      var label = (i + 1) + ". " + STAGE_TITLES[s];
      if (info.url && s !== stage && info.status !== "locked") {
        var a = element("a", "", label);
        a.href = info.url;
        li.appendChild(a);
      } else {
        li.appendChild(element("span", "", label));
      }
      li.title = STAGE_TITLES[s] + ": " + info.status;
      stageTrack.appendChild(li);
    });
    skipStageButton.hidden = ended || !workflow.current || workflow.current !== stage;
  }

  function showNextStage(msg) {
    if (!msg) return;
    if (!msg.next) {
      nextStageText.textContent = "Every stage of this feature is finished.";
      nextStageGo.hidden = true;
      nextStageBox.hidden = false;
      return;
    }
    var from = STAGE_TITLES[msg.from] || "Stage";
    var to = STAGE_TITLES[msg.next] || msg.next;
    nextStageText.textContent = msg.reopened
      ? "Verification sent work back. " + to + " is open again with your issues queued."
      : from + (msg.skipped ? " skipped." : " approved.") + " " + to + " is ready.";
    nextStageGo.textContent = msg.reopened ? "Open " + to + " →" : "Start " + to + " →";
    nextStageGo.hidden = false;
    nextStageAction = function () {
      nextStageGo.disabled = true;
      // One click: launch a fresh Claude for the next stage, then open its page.
      var go = function () { if (msg.next_url) window.location.href = msg.next_url; };
      if (msg.reopened || !msg.next_key) return go();
      connectClaude(false, msg.next_key).then(go, go);
    };
    nextStageBox.hidden = false;
  }

  function skipStage() {
    if (!workflow) return;
    confirmAction("Skip " + (STAGE_TITLES[workflow.current] || "this stage") + "?", "The next stage opens without this stage's approval. You can still come back to this page.", "Skip stage")
      .then(function (ok) {
        if (!ok) return;
        fetch("/api/workflows/" + encodeURIComponent(workflow.id) + "/skip", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
          .then(function (res) {
            return readJson(res).then(function (body) {
              if (!res.ok) return showHint(errorMessage(body, res.status), true);
              if (body.workflow) workflow = mergeWorkflow(body.workflow);
              renderWorkflow();
              showNextStage({ from: stage, next: body.next, next_url: body.next_url, next_key: body.next_key, skipped: true });
            });
          })
          .catch(function () { showHint("Could not reach see-plan.", true); });
      });
  }

  function mergeWorkflow(wf) {
    var out = { id: wf.id, name: wf.name, current: wf.current, stages: {} };
    STAGES.forEach(function (s) {
      var st = wf.stages[s] || {};
      var base = document.body.getAttribute("data-base-url") || "";
      out.stages[s] = { status: st.status, key: st.key || null, url: st.url || (st.key ? base + "/session/" + st.key : null) };
    });
    return out;
  }

  // ---- decisions -----------------------------------------------------------

  var decisionValue = null;
  var decisionForce = false;

  function openDecision(value) {
    decisionValue = value;
    decisionForce = false;
    var approve = value === "approve";
    $("decisionTitle").textContent = approve ? approveButton.textContent + "?" : "Request changes";
    $("decisionLabel").textContent = approve ? "Comment (optional)" : "What should change?";
    $("decisionComment").value = "";
    $("decisionError").textContent = approve && queue.length
      ? "You have " + queue.length + " unsent note(s). Send them first, or approve anyway."
      : "";
    $("decisionOk").textContent = approve ? (queue.length ? "Approve anyway" : approveButton.textContent) : "Send request";
    openDialog(decisionDialog);
    $("decisionComment").focus();
  }

  function submitDecision() {
    var comment = $("decisionComment").value.trim();
    if (decisionValue === "request-changes" && !comment) {
      $("decisionError").textContent = "Say what should change.";
      return;
    }
    $("decisionOk").disabled = true;
    api("/decision", { decision: decisionValue, comment: comment, force: decisionForce })
      .then(function (r) {
        if (!r.ok) {
          var code = r.body && r.body.error && r.body.error.code;
          if (code === "UNSENT_NOTES") {
            decisionForce = true;
            $("decisionError").textContent = (r.body.error.message || "Notes have not reached the agent yet") + ". Approve anyway?";
            $("decisionOk").textContent = "Approve anyway";
            return;
          }
          $("decisionError").textContent = errorMessage(r.body, r.status);
          return;
        }
        closeDialog(decisionDialog);
        if (decisionValue === "approve") {
          showHint("Approved.", false);
          setEnded("approved");
        } else {
          showHint("Change request sent.", false);
        }
        if (r.body.workflow) {
          workflow = mergeWorkflow(r.body.workflow);
          renderWorkflow();
        }
        if (r.body.next !== undefined && workflow) {
          showNextStage({ from: stage, next: r.body.next, next_url: r.body.next_url, next_key: r.body.next_key, reopened: decisionValue !== "approve" });
        }
      })
      .catch(function () { $("decisionError").textContent = "Could not reach see-plan."; })
      .then(function () { $("decisionOk").disabled = false; });
  }

  // ---- dialogs -------------------------------------------------------------

  function openDialog(d) {
    if (typeof d.showModal === "function") d.showModal();
    else d.setAttribute("open", "");
  }

  function closeDialog(d) {
    if (typeof d.close === "function") d.close();
    else d.removeAttribute("open");
  }

  var confirmResolve = null;
  function confirmAction(title, text, okLabel) {
    $("confirmTitle").textContent = title;
    $("confirmText").textContent = text;
    $("confirmOk").textContent = okLabel;
    openDialog(confirmDialog);
    $("confirmCancel").focus();
    return new Promise(function (resolve) { confirmResolve = resolve; });
  }

  function finishConfirm(ok) {
    closeDialog(confirmDialog);
    var r = confirmResolve;
    confirmResolve = null;
    if (r) r(ok);
  }

  function openFeedback() {
    $("feedbackForm").reset();
    $("feedbackError").textContent = "";
    openDialog(feedbackDialog);
  }

  function submitFeedback(event) {
    event.preventDefault();
    var form = $("feedbackForm");
    var rating = form.querySelector("input[name=rating]:checked");
    if (!rating) {
      $("feedbackError").textContent = "Pick 👍 or 👎.";
      return;
    }
    var categories = Array.prototype.map.call(form.querySelectorAll("input[name=category]:checked"), function (c) { return c.value; });
    $("feedbackSend").disabled = true;
    api("/session-feedback", { rating: rating.value, categories: categories, text: $("feedbackText").value })
      .then(function (r) {
        if (!r.ok) {
          $("feedbackError").textContent = errorMessage(r.body, r.status);
          return;
        }
        closeDialog(feedbackDialog);
        if (r.body && Array.isArray(r.body.chat)) renderChat(r.body.chat);
        showHint("Thanks. Your session feedback was sent to the agent.", false);
      })
      .catch(function () { $("feedbackError").textContent = "Could not reach see-plan."; })
      .then(function () { $("feedbackSend").disabled = false; });
  }

  // ---- ended state ---------------------------------------------------------

  function setEnded(by) {
    if (ended) return;
    ended = true;
    document.body.classList.add("ended");
    stopLaunch();
    showHint("", false);
    endedText.textContent = by === "approved" || boot.ended_by === "approved" ? "Approved ✓ Session ended" : "Session ended";
    endedBanner.hidden = false;
    newSessionButton.hidden = false;
    setFrameMode(false);
    postToFrame({ type: "ended" });
    renderControls();
    renderQueue();
    renderConnection();
    renderStage();
    renderWorkflow();
    hidePopover();
  }

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
      prompt_id: newPromptId(),
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
    showHint("", false);
    saveQueue();
    renderQueue();
    queuedLog.scrollTop = queuedLog.scrollHeight;
  }

  /** The top-level blocks whose text changed between two DOM snapshots, as selectors. */
  function changedBlocks(before, after) {
    if (!before || !after || typeof DOMParser === "undefined") return [];
    var parser = new DOMParser();
    var a = parser.parseFromString(before, "text/html").body;
    var b = parser.parseFromString(after, "text/html").body;
    if (!a || !b) return [];
    var old = {};
    Array.prototype.forEach.call(a.children, function (el) { old[(el.textContent || "").replace(/\s+/g, " ").trim()] = true; });
    var out = [];
    Array.prototype.forEach.call(b.children, function (el, i) {
      var text = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (text && !old[text]) out.push("body > :nth-child(" + (i + 1) + ")");
    });
    return out.length > HIGHLIGHT_LIMIT ? [] : out; // a rewrite of everything is not worth outlining
  }

  function onFrameReady() {
    frameLoads++;
    if (ended) {
      postToFrame({ type: "setMode", annotate: false });
      postToFrame({ type: "ended" });
    } else if (frameLoads > 1) postToFrame({ type: "setMode", annotate: annotate });
    if (pendingRestore) {
      postToFrame({ type: "restoreScroll", x: pendingRestore.x, y: pendingRestore.y });
      pendingRestore = null;
    }
    requestSnapshot().then(function (html) {
      if (previousSnapshot !== null && html) {
        var added = changedBlocks(previousSnapshot, html);
        if (added.length) postToFrame({ type: "highlightChanges", added: added });
      }
      previousSnapshot = null;
      if (html) currentSnapshot = html;
    });
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

  function loadLatest(revision) {
    shownRevision = Number(revision);
    pendingRestore = lastScroll;
    previousSnapshot = currentSnapshot;
    frame.removeAttribute("srcdoc");
    frame.src = "/artifact/" + encodeURIComponent(key) + "/index.html?rev=" + encodeURIComponent(String(revision));
  }

  // ---- revisions -----------------------------------------------------------

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

  function renderRevisionButton() {
    revisionButton.textContent = "Revision r" + (viewingRevision === null ? latestRevision : viewingRevision) + " ▾";
  }

  function toggleRevisionMenu() {
    var open = revisionMenu.hidden;
    revisionMenu.hidden = !open;
    revisionButton.setAttribute("aria-expanded", open ? "true" : "false");
    if (!open) return;
    revisionMenu.textContent = "";
    revisionMenu.appendChild(element("span", "menu-note", "Loading…"));
    fetch("/api/" + encodeURIComponent(key) + "/revisions")
      .then(readJson)
      .then(function (body) {
        revisionMenu.textContent = "";
        var list = body && Array.isArray(body.revisions) ? body.revisions.slice().reverse() : [];
        if (!list.length) revisionMenu.appendChild(element("span", "menu-note", "No earlier revisions yet."));
        list.forEach(function (r) {
          var item = element("button", "", "r" + r.n + (r.n === latestRevision ? " (latest)" : "") + " · " + timeAgo(r.at));
          item.type = "button";
          item.setAttribute("role", "menuitem");
          item.addEventListener("click", function () {
            toggleRevisionMenu();
            if (r.n === latestRevision) showLatest();
            else showRevision(r.n);
          });
          revisionMenu.appendChild(item);
        });
      })
      .catch(function () {
        revisionMenu.textContent = "";
        revisionMenu.appendChild(element("span", "menu-note", "Could not load revisions."));
      });
  }

  function showRevision(n) {
    fetch("/api/" + encodeURIComponent(key) + "/revisions/" + n)
      .then(readJson)
      .then(function (body) {
        if (!body || typeof body.html !== "string") return showHint("That revision is gone.", true);
        viewingRevision = n;
        frame.srcdoc = body.html; // read-only: no SDK, so no notes on an old revision
        revisionBarText.textContent = "Viewing revision r" + n + " (read-only).";
        revisionBar.hidden = false;
        renderRevisionButton();
      })
      .catch(function () { showHint("Could not load that revision.", true); });
  }

  function showLatest() {
    viewingRevision = null;
    revisionBar.hidden = true;
    renderRevisionButton();
    loadLatest(latestRevision);
  }

  // ---- sending -------------------------------------------------------------

  function errorMessage(body, status) {
    var err = body && body.error;
    if (err && err.message) return err.message;
    if (err && err.code) return err.code;
    return "Request failed (HTTP " + status + ")";
  }

  function readJson(res) {
    return res.json().catch(function () { return null; });
  }

  function sentHint(body) {
    return body && body.delivered === "queued-for-agent" ? "Sent." : "Queued. The agent gets it when it connects.";
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
            showHint(batch.length ? sentHint(body) : "", false);
            if (end) setEnded("user");
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

  function confirmEnd(withSend) {
    closeMore();
    var unsent = queue.length + (input.value.trim() ? 1 : 0);
    var text = withSend
      ? "Your notes are sent, then the session ends. The agent stops listening."
      : unsent
        ? "You have " + unsent + " unsent note(s); they will not be sent. The agent stops listening."
        : "The agent stops listening. You can resume later and keep the history.";
    confirmAction(withSend ? "Send and end the session?" : "End the session?", text, withSend ? "Send & End" : "End session").then(function (ok) {
      if (!ok) return;
      if (withSend) send(true);
      else endSession();
    });
  }

  function endSession() {
    if (ended || sending) return;
    sending = true;
    renderControls();
    api("/end", {})
      .then(function (r) {
        if (r.ok) setEnded("user");
        else showHint(errorMessage(r.body, r.status), true);
      })
      .catch(function (e) { showHint("Could not reach see-plan: " + (e && e.message ? e.message : e), true); })
      .then(function () {
        sending = false;
        renderControls();
      });
  }

  function restart(path, button) {
    button.disabled = true;
    api(path, {})
      .then(function (r) {
        if (r.ok) window.location.reload();
        else {
          button.disabled = false;
          showHint(errorMessage(r.body, r.status), true);
        }
      })
      .catch(function (e) {
        button.disabled = false;
        showHint("Could not reach see-plan: " + (e && e.message ? e.message : e), true);
      });
  }

  function commentOnPlan() {
    closeMore();
    var text = input.value.trim();
    if (!text) {
      showHint("Type your comment on the whole plan first, then choose this again.", false);
      input.focus();
      return;
    }
    input.value = "";
    enqueue({ prompt: text, tag: "plan", selector: "", text: "" });
    showHint("Queued as a comment on the whole plan.", false);
  }

  function closeMore() {
    moreMenu.hidden = true;
    moreButton.setAttribute("aria-expanded", "false");
  }

  // ---- Claude log tab ------------------------------------------------------

  function selectTab(showLog, focus) {
    logVisible = showLog;
    chatPanel.hidden = showLog;
    claudeLog.hidden = !showLog;
    tabChat.setAttribute("aria-selected", showLog ? "false" : "true");
    tabLog.setAttribute("aria-selected", showLog ? "true" : "false");
    tabChat.tabIndex = showLog ? -1 : 0;
    tabLog.tabIndex = showLog ? 0 : -1;
    if (focus) (showLog ? tabLog : tabChat).focus();
    if (showLog) {
      refreshLog();
      if (!claudePicker.hidden) loadSessions();
    } else {
      clearTimeout(logTimer);
      hidePopover();
    }
  }

  function waitingText() {
    return "Waiting for Claude's log for session " + claudeSessionId + "…";
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

  function renderPicker() {
    var showList = !claudeSessionId || pickerOpen || logMissing;
    claudeHeader.hidden = !claudeSessionId;
    claudeCurrent.textContent = claudeSessionId ? "Session " + claudeSessionId.slice(0, 8) : "";
    claudeCurrent.title = claudeSessionId;
    claudeChange.textContent = pickerOpen ? "Close list" : "Change session";
    claudeChange.hidden = showList && !pickerOpen;
    if (showList && claudePicker.hidden && logVisible) loadSessions();
    claudePicker.hidden = !showList;
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
      item.appendChild(element("span", "session-meta", [projectLabel(s), timeAgo(s.modified_at), s.id.slice(0, 8)].filter(Boolean).join(" · ")));
      item.addEventListener("click", function () { attachClaudeSession(s.id); });
      claudeSessions.appendChild(item);
    });
  }

  function loadSessions() {
    if (sessionsBusy) return;
    sessionsBusy = true;
    if (!claudeSessions.childNodes.length) claudeSessions.appendChild(element("p", "picker-empty", "Loading…"));
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
    var kind = entry.kind === "tool_use" ? " · tool call" : entry.kind === "tool_result" ? " · tool result" : "";
    var label = who + kind;
    row.appendChild(element("div", "log-label", label));
    row.appendChild(element("div", "log-text", String(entry.text || ""))); // textContent only: tool output is untrusted
    row.tabIndex = 0;
    row.setAttribute("role", "button");
    row.setAttribute("aria-label", label + (entry.at ? " at " + String(entry.at) : "") + ": add a note or log it");
    row.title = (entry.at ? String(entry.at) + "\n" : "") + "Click to add a note, send it to the agent, or log it as an error";
    var ref = logRef(entry);
    if (ref) {
      row.setAttribute("data-ref", ref);
      if (sentLogRefs[ref]) row.classList.add("sent");
    }
    row.addEventListener("click", function () {
      var selection = window.getSelection ? window.getSelection() : null;
      if (selection && !selection.isCollapsed && row.contains(selection.anchorNode)) return; // copying text, not picking
      openPopover(entry, row);
    });
    row.addEventListener("keydown", function (event) {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openPopover(entry, row);
      }
    });
    claudeEntries.appendChild(row);
  }

  function openPopover(entry, row) {
    popoverEntry = entry;
    popoverRow = row;
    logNote.value = "";
    var rect = row.getBoundingClientRect();
    logPopover.style.top = Math.min(window.innerHeight - 220, Math.max(8, rect.bottom + 4)) + "px";
    logPopover.style.right = "12px";
    logPopover.hidden = false;
    $("logSend").disabled = ended;
    $("logBoth").disabled = ended;
    logNote.focus();
  }

  function hidePopover() {
    logPopover.hidden = true;
    if (popoverRow) popoverRow.focus();
    popoverEntry = null;
    popoverRow = null;
  }

  function entryRecord(entry) {
    return {
      claude_session_id: claudeSessionId,
      uuid: typeof entry.uuid === "string" ? entry.uuid : null,
      part: Number(entry.part) || 0,
      role: String(entry.role || ""),
      kind: String(entry.kind || ""),
      at: entry.at ? String(entry.at) : null,
      text: String(entry.text || ""),
    };
  }

  /** The server writes the error log itself; the agent is never asked to. */
  function logAsError(entry) {
    return fetch("/api/claude-errors", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entry: entryRecord(entry) }),
    }).then(function (res) {
      return readJson(res).then(function (body) {
        if (!res.ok) throw new Error(errorMessage(body, res.status));
        return body;
      });
    });
  }

  function sendEntryToAgent(entry, row, note, logged) {
    var prompt = {
      prompt_id: logRef(entry) || newPromptId(),
      prompt: note || "Look at this Claude log entry.",
      tag: LOG_TAG,
      selector: "",
      text: "",
      target: { entry: entryRecord(entry), note: note, logged_as_error: Boolean(logged), error_log: logged ? ERROR_LOG : null },
    };
    return fetch("/api/" + encodeURIComponent(key) + "/prompts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompts: [prompt], dom_snapshot: "" }),
    }).then(function (res) {
      return readJson(res).then(function (body) {
        if (res.ok && body && Array.isArray(body.chat)) {
          row.classList.add("sent");
          renderChat(body.chat);
          return body;
        }
        if (res.status === 409 && body && body.error && body.error.code === "ENDED") setEnded();
        throw new Error(errorMessage(body, res.status));
      });
    });
  }

  function popoverAction(toAgent, asError) {
    var entry = popoverEntry;
    var row = popoverRow;
    if (!entry || !row) return;
    var note = logNote.value.trim();
    if (toAgent && row.classList.contains("sent")) {
      showHint("That entry was already sent to the agent.", false);
      hidePopover();
      return;
    }
    hidePopover();
    var step = asError ? logAsError(entry) : Promise.resolve(null);
    step
      .then(function (logged) {
        if (!toAgent) {
          showHint(logged && logged.duplicate ? "Already in " + ERROR_LOG + "." : "Logged to " + ERROR_LOG + ".", false);
          return;
        }
        return sendEntryToAgent(entry, row, note, asError).then(function (body) {
          showHint((asError ? "Logged to " + ERROR_LOG + ". " : "") + sentHint(body), false);
        });
      })
      .catch(function (e) { showHint(e && e.message ? e.message : String(e), true); });
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
        if (body.omitted && !first) claudeEntries.textContent = "";
        if (body.omitted) claudeStatus.textContent = "Earlier entries omitted";
        else if (first) claudeStatus.textContent = body.entries.length ? "" : "Claude has not written anything yet.";
        else if (body.entries.length) claudeStatus.textContent = "";
        body.entries.forEach(addLogEntry);
        while (claudeEntries.childNodes.length > MAX_LOG_ENTRIES) claudeEntries.removeChild(claudeEntries.firstChild);
        if (typeof body.next === "number") logNext = body.next;
        if (body.entries.length && !pickerOpen && logPopover.hidden) claudeLog.scrollTop = claudeLog.scrollHeight;
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
    if (id === claudeSessionId) {
      renderPicker();
      return;
    }
    claudeSessionId = id;
    resetLog();
    renderConnection();
    if (logVisible) refreshLog();
  }

  function attachClaudeSession(id) {
    if (!id) return;
    claudeAttachButton.disabled = true;
    api("/claude-session", { id: id })
      .then(function (r) {
        if (r.ok) {
          claudeInput.value = "";
          pickerOpen = false;
          onClaudeSession(id);
        } else {
          claudeStatus.textContent = errorMessage(r.body, r.status);
        }
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
      latestRevision = Number(msg.revision);
      if (viewingRevision === null) loadLatest(msg.revision);
      else revisionBarText.textContent = "Viewing revision r" + viewingRevision + " (read-only). A newer revision r" + latestRevision + " is available.";
      renderRevisionButton();
    } else if (msg.type === "ended") {
      setEnded(msg.ended_by);
    } else if (msg.type === "claude-session" && typeof msg.id === "string") {
      onClaudeSession(msg.id);
    } else if (msg.type === "new-session") {
      window.location.reload();
    } else if (msg.type === "stage") {
      stage = msg.stage || "";
      stageSource = msg.source || "";
      renderStage();
      renderWorkflow();
    } else if (msg.type === "stage-ready") {
      if (workflow && msg.next) {
        if (workflow.stages[msg.next]) {
          workflow.stages[msg.next].status = "current";
          workflow.stages[msg.next].url = msg.next_url;
        }
        workflow.current = msg.next;
        renderWorkflow();
      }
      showNextStage(msg);
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
  sendAndEndButton.addEventListener("click", function () { confirmEnd(true); });
  endButton.addEventListener("click", function () { confirmEnd(false); });
  commentPlanButton.addEventListener("click", commentOnPlan);
  moreButton.addEventListener("click", function () {
    var open = moreMenu.hidden;
    moreMenu.hidden = !open;
    moreButton.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) commentPlanButton.focus();
  });
  newSessionButton.addEventListener("click", function () { restart("/new-session", newSessionButton); });
  resumeSessionButton.addEventListener("click", function () { restart("/reopen", resumeSessionButton); });
  connectButton.addEventListener("click", function () { connectClaude(false); });
  resumeClaudeButton.addEventListener("click", function () { connectClaude(true); });
  retryConnectButton.addEventListener("click", function () {
    stopLaunch();
    api("/connect-cancel", {}).catch(function () {}).then(function () { connectClaude(false); });
  });
  cancelConnectButton.addEventListener("click", cancelConnect);
  copyAllowButton.addEventListener("click", function () { copyText(ALLOW_RULE, "Copied. Add it to permissions.allow in .claude/settings.json"); });
  copyCommandButton.addEventListener("click", function () { copyText(launch && launch.command ? launch.command : String(boot.poll_command || ""), "Command copied"); });
  copyPollButton.addEventListener("click", function () { copyText(String(boot.poll_command || ""), "Poll command copied"); });
  viewLogButton.addEventListener("click", function () { selectTab(true, true); });
  sessionFeedbackButton.addEventListener("click", openFeedback);
  $("feedbackForm").addEventListener("submit", submitFeedback);
  $("feedbackCancel").addEventListener("click", function () { closeDialog(feedbackDialog); });
  $("confirmCancel").addEventListener("click", function () { finishConfirm(false); });
  $("confirmOk").addEventListener("click", function () { finishConfirm(true); });
  confirmDialog.addEventListener("cancel", function () { finishConfirm(false); });
  approveButton.addEventListener("click", function () { openDecision("approve"); });
  requestChangesButton.addEventListener("click", function () { openDecision("request-changes"); });
  $("decisionOk").addEventListener("click", submitDecision);
  $("decisionCancel").addEventListener("click", function () { closeDialog(decisionDialog); });
  stageSelect.addEventListener("change", function () { setStage(stageSelect.value); });
  stageConfirm.addEventListener("click", function () { setStage(stage); });
  revisionButton.addEventListener("click", toggleRevisionMenu);
  backToLatest.addEventListener("click", showLatest);
  skipStageButton.addEventListener("click", skipStage);
  nextStageGo.addEventListener("click", function () { if (nextStageAction) nextStageAction(); });
  $("logSend").addEventListener("click", function () { popoverAction(true, false); });
  $("logError").addEventListener("click", function () { popoverAction(false, true); });
  $("logBoth").addEventListener("click", function () { popoverAction(true, true); });
  $("logCancel").addEventListener("click", hidePopover);
  logPopover.addEventListener("keydown", function (event) {
    if (event.key === "Escape") hidePopover();
  });
  tabChat.addEventListener("click", function () { selectTab(false); });
  tabLog.addEventListener("click", function () { selectTab(true); });
  [tabChat, tabLog].forEach(function (tab) {
    tab.addEventListener("keydown", function (event) {
      if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
        event.preventDefault();
        selectTab(tab === tabChat, true);
      } else if (event.key === "Home" || event.key === "End") {
        event.preventDefault();
        selectTab(event.key === "End", true);
      }
    });
  });
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
  document.addEventListener("click", function (event) {
    if (!moreMenu.hidden && !moreMenu.contains(event.target) && event.target !== moreButton) closeMore();
    if (!revisionMenu.hidden && !revisionMenu.contains(event.target) && event.target !== revisionButton) {
      revisionMenu.hidden = true;
      revisionButton.setAttribute("aria-expanded", "false");
    }
  });
  annotateButton.addEventListener("click", toggleAnnotate);
  document.addEventListener("keydown", function (event) {
    if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey
        && (event.key === "i" || event.key === "I")) {
      event.preventDefault();
      toggleAnnotate();
    }
    if (event.key === "Escape") {
      closeMore();
      if (!logPopover.hidden) hidePopover();
    }
  });

  renderChat(Array.isArray(boot.chat) ? boot.chat : []);
  renderHistory();
  renderQueue();
  renderControls();
  renderStage();
  renderWorkflow();
  renderRevisionButton();
  resetLog();
  renderConnection();
  if (boot.status === "ended") setEnded(boot.ended_by);
  loadClaudeStatus();
  connect();
})();
