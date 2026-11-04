/* see-plan error logs page. In a project: four tabs (session errors, plan errors, the project's superpowers plans,
   Claude sessions). Outside one: only the Sessions tab. The tabs are read from the page. textContent only. */
(function () {
  "use strict";

  // A copy of src/severity.js (plain data): the page has no module loader.
  var SEVERITIES = ["low", "medium", "high", "send_to_it"];
  var SEVERITY_TITLES = { low: "Low", medium: "Medium", high: "High", send_to_it: "Send to IT" };
  var REASON_REQUIRED = ["high", "send_to_it"];
  var FILTERS = ["all"].concat(SEVERITIES, ["unrated"]);
  var FILTER_TITLES = { all: "All", low: "Low", medium: "Medium", high: "High", send_to_it: "Send to IT", unrated: "Unrated" };
  var PROJECT = document.body.getAttribute("data-project") || ""; // "" = sessions only (D13)
  var TABS = Array.prototype.slice.call(document.querySelectorAll('[role="tab"]')).map(function (t) { return t.getAttribute("data-tab"); });
  var CONTEXT = { "session-errors": "session", "plan-errors": "plan" };
  var PAGE = 50;
  var REFRESH_MS = 30000;
  var EMPTY = {
    "session-errors": "No errors logged from sessions yet. Log one from the Claude log page.",
    "plan-errors": "No errors logged from planning sessions yet. Log one from a plan's Claude log.",
    plans: "No superpowers plans in this project yet. Files in docs/superpowers/plans/ show up here.",
    sessions: "No Claude sessions found in ~/.claude/projects.",
  };

  var statusEl = document.getElementById("status");
  var tabs = TABS.map(function (id) { return document.getElementById("tab-" + id); });
  var state = {}; // tab id -> { loaded, filter, items, next_offset, total, busy }
  TABS.forEach(function (id) { state[id] = { loaded: false, filter: "all", items: [], next_offset: null, total: 0, busy: false, seq: 0 }; });
  var summary = null;
  var active = null;
  var timer = null;

  // ---- helpers ----

  function element(tag, className, text) {
    var el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined && text !== null) el.textContent = String(text); // untrusted: never parsed as HTML
    return el;
  }

  function link(href, text, title) {
    var a = element("a", "", text);
    a.href = href;
    if (title) a.title = title;
    return a;
  }

  function claudeHref(id) {
    return "/claude?id=" + encodeURIComponent(id);
  }

  function sessionHref(key) {
    return "/session/" + encodeURIComponent(key);
  }

  function readJson(res) {
    return res.json().catch(function () { return null; }).then(function (body) {
      if (!res.ok) throw new Error(body && body.error && body.error.message ? body.error.message : "HTTP " + res.status);
      return body;
    });
  }

  function getJson(url) {
    return fetch(url).then(readJson);
  }

  function setStatus(text, isError) {
    statusEl.textContent = text || "";
    statusEl.classList.toggle("error", Boolean(isError));
  }

  function isSeverity(v) {
    return typeof v === "string" && SEVERITIES.indexOf(v) !== -1;
  }

  /** Always the text label, never color alone. */
  function badge(severity) {
    var id = isSeverity(severity) ? severity : "unrated";
    return element("span", "sev-badge sev-" + id, FILTER_TITLES[id]);
  }

  function formatDate(iso) {
    var t = Date.parse(iso);
    return isFinite(t) ? new Date(t).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "";
  }

  /** Plans are dated by day (the name prefix), so no time of day. */
  function formatDay(iso) {
    var t = Date.parse(iso);
    return isFinite(t) ? new Date(t).toLocaleDateString(undefined, { dateStyle: "medium" }) : "";
  }

  function basename(p) {
    var parts = String(p || "").split(/[\\/]/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : "";
  }

  function projectLabel(s) {
    return basename(s.cwd) || String(s.project || "");
  }

  function cell(row, content, className) {
    var td = element("td", className || "");
    if (content instanceof Node) td.appendChild(content);
    else td.textContent = content === undefined || content === null ? "" : String(content);
    row.appendChild(td);
    return td;
  }

  function table(headers) {
    var t = element("table", "grid");
    var head = element("thead");
    var tr = element("tr");
    headers.forEach(function (h) {
      var th = element("th", "", h);
      th.scope = "col";
      tr.appendChild(th);
    });
    head.appendChild(tr);
    t.appendChild(head);
    var body = element("tbody");
    t.appendChild(body);
    return { table: t, body: body };
  }

  function errorsCell(count, worst) {
    var wrap = element("span", "errors-cell");
    wrap.appendChild(element("span", "error-count", String(count || 0)));
    if (count) wrap.appendChild(badge(worst));
    return wrap;
  }

  function panelBody(id) {
    return document.querySelector('[data-panel="' + id + '"] .panel-body');
  }

  // ---- tabs ----

  function tabFromHash() {
    var h = String(location.hash || "").replace(/^#/, "");
    return TABS.indexOf(h) !== -1 ? h : TABS[0];
  }

  function select(id, focus) {
    active = id;
    tabs.forEach(function (tab) {
      var on = tab.getAttribute("data-tab") === id;
      tab.setAttribute("aria-selected", String(on));
      tab.tabIndex = on ? 0 : -1;
      if (on && focus) tab.focus();
    });
    TABS.forEach(function (t) {
      document.getElementById("panel-" + t).hidden = t !== id;
    });
    if (location.hash !== "#" + id) {
      try {
        history.replaceState(null, "", "#" + id);
      } catch (e) {
        location.hash = id;
      }
    }
    load(id); // first open loads; reopening refreshes
    schedule();
  }

  tabs.forEach(function (tab, i) {
    tab.addEventListener("click", function () { select(tab.getAttribute("data-tab"), false); });
    tab.addEventListener("keydown", function (event) {
      var next = null;
      if (event.key === "ArrowRight") next = (i + 1) % tabs.length;
      else if (event.key === "ArrowLeft") next = (i - 1 + tabs.length) % tabs.length;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = tabs.length - 1;
      if (next === null) return;
      event.preventDefault();
      select(tabs[next].getAttribute("data-tab"), true);
    });
  });

  window.addEventListener("hashchange", function () {
    var id = tabFromHash();
    if (id !== active) select(id, false);
  });

  // Only the visible tab refreshes, every 30 s, and never while the page is hidden.
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(function () {
      if (!document.hidden && active) {
        loadSummary();
        load(active);
      }
      schedule();
    }, REFRESH_MS);
  }

  document.addEventListener("visibilitychange", function () {
    if (!document.hidden && active) {
      loadSummary();
      load(active);
    }
  });

  // ---- counts ----

  function setCount(id, n) {
    var el = document.querySelector('[data-count="' + id + '"]');
    if (el) el.textContent = typeof n === "number" ? "(" + n + ")" : "";
  }

  function loadSummary() {
    if (!PROJECT) return Promise.resolve(); // sessions only: no error counts to show
    return getJson("/api/errors/summary?project=" + encodeURIComponent(PROJECT))
      .then(function (body) {
        summary = body;
        if (body && body.counts) {
          setCount("session-errors", body.counts.session.all);
          setCount("plan-errors", body.counts.plan.all);
        }
        if (body && typeof body.plans === "number") setCount("plans", body.plans);
        ["session-errors", "plan-errors"].forEach(function (id) {
          if (state[id].loaded) renderChips(id);
        });
      })
      .catch(function (e) { setStatus("Could not load the counts: " + e.message, true); });
  }

  // ---- loading ----

  // A fresh load (a filter change, a refresh) always runs and wins over one in flight; only "Load more" waits.
  function load(id, more) {
    var s = state[id];
    if (more && s.busy) return;
    s.busy = true;
    var seq = ++s.seq;
    var stale = function () { return seq !== s.seq; };
    var request;
    if (CONTEXT[id]) {
      var q = "?context=" + encodeURIComponent(CONTEXT[id]) + "&limit=" + PAGE + "&offset=" + (more ? s.next_offset || 0 : 0);
      if (s.filter !== "all") q += "&severity=" + encodeURIComponent(s.filter);
      request = getJson("/api/errors" + q).then(function (body) {
        if (stale()) return;
        s.items = more ? s.items.concat(body.items || []) : body.items || [];
        s.next_offset = body.next_offset;
        s.total = body.total;
      });
    } else if (id === "plans") {
      request = getJson("/api/projects/" + encodeURIComponent(PROJECT) + "/plans").then(function (body) {
        if (stale()) return;
        s.items = body.items || [];
        setCount("plans", typeof body.total === "number" ? body.total : s.items.length);
      });
    } else {
      request = getJson("/api/claude-sessions?limit=75").then(function (body) {
        if (stale()) return;
        s.items = body.sessions || [];
        setCount("sessions", s.items.length);
      });
    }
    request
      .then(function () {
        if (stale()) return;
        s.loaded = true;
        render(id);
        if (statusEl.classList.contains("error")) setStatus("", false);
      })
      .catch(function (e) { if (!stale()) setStatus("Could not load this tab: " + e.message, true); })
      .then(function () { if (!stale()) s.busy = false; });
  }

  function render(id) {
    var body = panelBody(id);
    body.textContent = "";
    if (CONTEXT[id]) return renderErrors(id, body);
    if (id === "plans") return renderPlans(body);
    return renderSessions(body);
  }

  // ---- error tabs ----

  function renderChips(id) {
    var bar = document.querySelector('[data-panel="' + id + '"] .chips');
    if (!bar) return;
    bar.textContent = "";
    var counts = summary && summary.counts ? summary.counts[CONTEXT[id]] : null;
    FILTERS.forEach(function (f) {
      var chip = element("button", "chip" + (f === "all" ? "" : " sev-" + f));
      chip.type = "button";
      chip.setAttribute("aria-pressed", String(state[id].filter === f));
      if (f !== "all") chip.appendChild(element("span", "swatch"));
      chip.appendChild(document.createTextNode(FILTER_TITLES[f] + (counts ? " (" + (counts[f] || 0) + ")" : "")));
      chip.addEventListener("click", function () {
        if (state[id].filter === f) return;
        state[id].filter = f;
        load(id);
      });
      bar.appendChild(chip);
    });
  }

  function renderErrors(id, body) {
    var s = state[id];
    var chips = element("div", "chips");
    chips.setAttribute("role", "group");
    chips.setAttribute("aria-label", "Filter by severity");
    body.appendChild(chips);
    renderChips(id);
    if (!s.items.length) {
      body.appendChild(element("p", "empty", s.filter === "all" ? EMPTY[id] : "No " + FILTER_TITLES[s.filter] + " errors here."));
      return;
    }
    var plan = id === "plan-errors";
    var headers = ["Severity", "Error", "Reason", "Session"];
    if (plan) headers.push("Plan/file");
    headers.push("Logged");
    var t = table(headers);
    s.items.forEach(function (item) { t.body.appendChild(errorRow(item, plan)); });
    body.appendChild(t.table);
    var foot = element("p", "table-foot", "Showing " + s.items.length + " of " + s.total + ".");
    if (s.next_offset !== null && s.next_offset !== undefined) {
      var more = element("button", "", "Load more");
      more.type = "button";
      more.addEventListener("click", function () { load(id, true); });
      foot.appendChild(document.createTextNode(" "));
      foot.appendChild(more);
    }
    body.appendChild(foot);
  }

  function errorRow(item, plan) {
    var tr = element("tr", item.severity === "send_to_it" ? "row-send_to_it" : "");
    var sev = cell(tr, badge(item.severity), "col-severity");
    if (!isSeverity(item.severity)) {
      var rate = element("button", "rate", "Rate…");
      rate.type = "button";
      rate.addEventListener("click", function () { openRate(item); });
      sev.appendChild(document.createTextNode(" "));
      sev.appendChild(rate);
    }
    var errorTd = cell(tr, "", "col-error");
    var meta = [item.role === "assistant" ? "Claude" : "User", item.kind === "tool_use" ? "tool call" : item.kind === "tool_result" ? "tool result" : ""].filter(Boolean).join(" · ");
    errorTd.appendChild(element("div", "entry-meta", meta));
    var text = element("div", "entry-text", item.text + (item.truncated ? "…" : ""));
    errorTd.appendChild(text);
    if (item.truncated) {
      var expand = element("button", "link", "Show all");
      expand.type = "button";
      expand.setAttribute("aria-expanded", "false");
      expand.addEventListener("click", function () {
        var q = "?claude_session_id=" + encodeURIComponent(item.claude_session_id) + "&uuid=" + encodeURIComponent(item.uuid) + "&part=" + encodeURIComponent(item.part);
        expand.disabled = true;
        getJson("/api/errors/record" + q)
          .then(function (body) {
            text.textContent = body.record.text;
            expand.remove();
          })
          .catch(function (e) {
            expand.disabled = false;
            setStatus("Could not load the full text: " + e.message, true);
          });
      });
      errorTd.appendChild(expand);
    }
    cell(tr, item.reason ? item.reason : element("span", "muted", "No reason given"), "col-reason");
    var title = item.claude_title || item.claude_session_id.slice(0, 8);
    cell(tr, link(claudeHref(item.claude_session_id), title, item.claude_session_id), "col-session");
    if (plan) {
      cell(tr, item.review_key && item.file ? link(sessionHref(item.review_key), basename(item.file), item.file) : element("span", "muted", "—"), "col-plan");
    }
    cell(tr, formatDate(item.reported_at), "col-logged");
    return tr;
  }

  // ---- plans and sessions ----

  function renderPlans(body) {
    var items = state.plans.items;
    if (!items.length) {
      body.appendChild(element("p", "empty", EMPTY.plans));
      return;
    }
    var t = table(["Plan", "Created", "Status", "Errors", ""]);
    items.forEach(function (p) {
      var tr = element("tr");
      var planTd = cell(tr, "", "col-plan");
      var title = p.title || p.name;
      planTd.appendChild(p.review_key ? link(sessionHref(p.review_key), title, p.file) : element("span", "plan-title", title));
      if (p.title) planTd.appendChild(element("div", "plan-file", p.name));
      cell(tr, formatDay(p.created_at));
      cell(tr, element("span", "status status-" + String(p.status || "").toLowerCase().replace(/[^a-z]+/g, "-"), p.status));
      cell(tr, errorsCell(p.error_count, p.worst_severity));
      var actions = cell(tr, "", "col-actions");
      if (!p.review_key) {
        var open = element("button", "", "Open");
        open.type = "button";
        open.setAttribute("aria-label", "Open " + p.name + " in see-plan");
        open.addEventListener("click", function () { openPlan(p, open); });
        actions.appendChild(open);
      }
      t.body.appendChild(tr);
    });
    body.appendChild(t.table);
    body.appendChild(element("p", "table-foot", "The " + items.length + " most recently created plans in docs/superpowers/plans/."));
  }

  function openPlan(p, button) {
    button.disabled = true;
    fetch("/api/projects/" + encodeURIComponent(PROJECT) + "/plans/open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: p.name }),
    })
      .then(readJson)
      .then(function (body) {
        if (!body || typeof body.key !== "string" || !/^[0-9a-f]{16}$/.test(body.key)) throw new Error("unexpected response");
        location.href = sessionHref(body.key);
      })
      .catch(function (e) {
        button.disabled = false;
        setStatus("Could not open the plan: " + e.message, true);
      });
  }

  function renderSessions(body) {
    var items = state.sessions.items;
    if (!items.length) {
      body.appendChild(element("p", "empty", EMPTY.sessions));
      return;
    }
    var t = table(["Session", "Project", "Last activity", "Review session / stage", "Errors"]);
    items.forEach(function (s) {
      var tr = element("tr");
      cell(tr, link(claudeHref(s.id), s.title || s.id.slice(0, 8), s.id), "col-session");
      cell(tr, projectLabel(s));
      cell(tr, formatDate(s.modified_at));
      if (s.review_key) {
        var wrap = element("span");
        wrap.appendChild(link(sessionHref(s.review_key), s.review_key.slice(0, 8)));
        if (s.stage) wrap.appendChild(element("span", "stage", " · " + s.stage));
        cell(tr, wrap);
      } else {
        cell(tr, element("span", "muted", "—"));
      }
      cell(tr, errorsCell(s.error_count, s.worst_severity));
      t.body.appendChild(tr);
    });
    body.appendChild(t.table);
    body.appendChild(element("p", "table-foot", "The " + items.length + " most recent Claude sessions."));
  }

  // ---- one-time rating of Unrated records (D6) ----

  var dialog = document.getElementById("rateDialog");
  var preview = document.getElementById("ratePreview");
  var rateInputs = Array.prototype.slice.call(document.querySelectorAll("#rateSeverity input[type=radio]"));
  var rateReason = document.getElementById("rateReason");
  var rateReasonLabel = document.getElementById("rateReasonLabel");
  var rateError = document.getElementById("rateError");
  var rateConfirm = document.getElementById("rateConfirm");
  var rating = null;

  function pickedRate() {
    for (var i = 0; i < rateInputs.length; i++) if (rateInputs[i].checked) return rateInputs[i].value;
    return null;
  }

  function updateRate() {
    var severity = pickedRate();
    var required = REASON_REQUIRED.indexOf(severity) !== -1 && !(rating && rating.reason);
    rateReasonLabel.textContent = required ? "Why is this an error? (required for High and Send to IT)" : "Why is this an error? (optional)";
    rateReason.required = required;
    rateConfirm.disabled = !severity || (required && !rateReason.value.trim());
  }

  function openRate(item) {
    rating = item;
    preview.textContent = item.text + (item.truncated ? "…" : "");
    rateInputs.forEach(function (input) { input.checked = false; });
    rateReason.value = item.reason || "";
    rateReason.readOnly = Boolean(item.reason);
    rateError.textContent = "";
    updateRate();
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    rateInputs[0].focus();
  }

  function closeRate() {
    if (typeof dialog.close === "function") dialog.close();
    else dialog.removeAttribute("open");
    rating = null;
  }

  rateInputs.forEach(function (input) { input.addEventListener("change", updateRate); });
  rateReason.addEventListener("input", updateRate);
  document.getElementById("rateCancel").addEventListener("click", closeRate);
  dialog.addEventListener("keydown", function (event) {
    if (/^[1-4]$/.test(event.key) && event.target !== rateReason && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      rateInputs[Number(event.key) - 1].checked = true;
      rateInputs[Number(event.key) - 1].focus();
      updateRate();
    }
  });
  dialog.addEventListener("submit", function (event) {
    event.preventDefault();
    var item = rating;
    var severity = pickedRate();
    if (!item || !severity) return;
    rateConfirm.disabled = true;
    fetch("/api/errors/rate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        claude_session_id: item.claude_session_id,
        uuid: item.uuid,
        part: item.part,
        severity: severity,
        reason: item.reason ? null : rateReason.value.trim() || null,
      }),
    })
      .then(readJson)
      .then(function () {
        closeRate();
        setStatus("Rated " + SEVERITY_TITLES[severity] + ".", false);
        loadSummary();
        if (active) load(active);
      })
      .catch(function (e) {
        rateError.textContent = e.message;
        updateRate();
      });
  });

  // ---- start ----

  loadSummary();
  select(tabFromHash(), false);
})();
