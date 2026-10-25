/* see-plan annotation SDK, injected into the artifact page.
 * Classic script (no imports). Everything lives in one IIFE so the only global
 * it adds to the artifact is the public `window.lavish` API.
 * The artifact runs in a sandboxed iframe with an opaque origin, so this file
 * must not touch storage APIs and posts to the parent with targetOrigin "*".
 * Messages carry source "my-lavish". Chrome -> SDK: setMode {annotate},
 * requestSnapshot {id}, restoreScroll {x,y}, ended {} (session over: stop
 * annotating and hide the note UI). SDK -> chrome: ready, mode, scroll,
 * snapshot, queuePrompt. */
(function () {
  "use strict";

  var SOURCE = "my-lavish";
  var MAX_SNAPSHOT_CHARS = 200000;
  var MAX_ELEMENT_TEXT = 300;
  var SCROLL_THROTTLE_MS = 200;
  var HOVER_OUTLINE = "2px solid #c8963e";
  var UI_ATTR = "data-my-lavish-ui";
  var STYLE_ID = "my-lavish-sdk-style";
  var IGNORED_TARGETS = [
    "input", "textarea", "select", "button", "label", "summary", "[contenteditable]",
    "[role=button]", "[role=checkbox]", "[role=radio]", "[role=tab]", "[role=switch]",
    "[role=option]", "[role=menuitem]", "[data-lavish-action]",
  ].join(", ");

  var framed = window.parent !== window;
  var annotate = document.documentElement.getAttribute("data-lavish-annotate") !== "off";
  var hovered = null; // { el, outline } while an element carries the hover outline
  var card = null; // the open note card element
  var commentButton = null;
  var pendingSelection = null; // { text, selector } captured when Comment is shown
  var scrollTimer = null;
  var ended = false; // the chrome reported the session over: no more notes

  // ---- messaging -----------------------------------------------------------

  function post(message) {
    if (!framed) return;
    message.source = SOURCE;
    try {
      window.parent.postMessage(message, "*");
    } catch (e) {
      // un-cloneable payload: drop the message rather than break the artifact
    }
  }

  window.addEventListener("message", function (event) {
    if (!framed || event.source !== window.parent) return;
    var data = event.data;
    if (!data || typeof data !== "object" || data.source !== SOURCE) return;
    if (data.type === "requestSnapshot") {
      post({ type: "snapshot", id: data.id, html: snapshot() });
    } else if (data.type === "setMode") {
      setAnnotate(Boolean(data.annotate) && !ended);
    } else if (data.type === "ended") {
      ended = true;
      closeCard();
      hideComment();
      setAnnotate(false);
    } else if (data.type === "restoreScroll") {
      var x = Number(data.x);
      var y = Number(data.y);
      if (isFinite(x) && isFinite(y)) window.scrollTo(x, y);
    }
  });

  // ---- helpers -------------------------------------------------------------

  function isElement(node) {
    return Boolean(node) && node.nodeType === 1;
  }

  function isUi(node) {
    var el = isElement(node) ? node : node && node.parentElement;
    return Boolean(el && el.closest && el.closest("[" + UI_ATTR + "]"));
  }

  function isIgnoredTarget(el) {
    return Boolean(el.closest && el.closest(IGNORED_TARGETS));
  }

  function isAnnotatable(node) {
    return isElement(node)
      && node !== document.documentElement
      && node !== document.body
      && !isUi(node)
      && !isIgnoredTarget(node);
  }

  function escapeIdent(value) {
    if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(value);
    return String(value).replace(/[^a-zA-Z0-9_-]/g, function (c) {
      return "\\" + c.charCodeAt(0).toString(16) + " ";
    });
  }

  function hasUniqueId(el) {
    if (!el.id) return false;
    try {
      return document.querySelectorAll("#" + escapeIdent(el.id)).length === 1;
    } catch (e) {
      return false;
    }
  }

  /** `#id` when the id is unique, else a `tag:nth-of-type(n)` path from body. */
  function cssSelector(el) {
    if (!isElement(el)) return "";
    if (hasUniqueId(el)) return "#" + escapeIdent(el.id);
    if (el === document.documentElement) return "html";
    var parts = [];
    var node = el;
    while (isElement(node) && node !== document.body && node !== document.documentElement) {
      var n = 1;
      for (var sib = node.previousElementSibling; sib; sib = sib.previousElementSibling) {
        if (sib.localName === node.localName) n++;
      }
      parts.unshift(node.localName + ":nth-of-type(" + n + ")");
      node = node.parentElement;
    }
    parts.unshift("body");
    return parts.join(" > ");
  }

  function elementText(el) {
    var text = typeof el.innerText === "string" ? el.innerText : el.textContent || "";
    return text.trim().slice(0, MAX_ELEMENT_TEXT);
  }

  function toPlainData(value) {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (e) {
      return undefined;
    }
  }

  // ---- injected UI ---------------------------------------------------------

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement("style");
    style.id = STYLE_ID;
    style.setAttribute(UI_ATTR, "");
    style.textContent = [
      ".my-lavish-card{position:fixed;z-index:2147483647;width:280px;box-sizing:border-box;",
      "padding:10px;border-radius:8px;background:#fffdf8;color:#2b2620;border:1px solid #c8963e;",
      "box-shadow:0 6px 24px rgba(0,0,0,.18);font:13px/1.4 system-ui,-apple-system,'Segoe UI',sans-serif;",
      "text-align:left;letter-spacing:normal;text-transform:none}",
      ".my-lavish-card *{box-sizing:border-box;font:inherit;color:inherit}",
      ".my-lavish-card-label{margin:0 0 6px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".my-lavish-card textarea{display:block;width:100%;min-height:64px;margin:0;padding:6px;resize:vertical;",
      "border:1px solid #d8cdb8;border-radius:6px;background:#fff;color:#2b2620}",
      ".my-lavish-card-actions{display:flex;justify-content:flex-end;gap:6px;margin-top:8px}",
      ".my-lavish-card button,.my-lavish-comment{cursor:pointer;margin:0;padding:4px 10px;border-radius:6px;",
      "border:1px solid #c8963e;background:#fff;color:#2b2620;font:600 12px/1.4 system-ui,-apple-system,'Segoe UI',sans-serif}",
      ".my-lavish-card button.my-lavish-primary,.my-lavish-comment{background:#c8963e;color:#fff}",
      ".my-lavish-comment{position:fixed;z-index:2147483647;box-shadow:0 2px 8px rgba(0,0,0,.2)}",
    ].join("");
    (document.head || document.documentElement).appendChild(style);
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(value, max));
  }

  function closeCard() {
    if (card && card.parentNode) card.parentNode.removeChild(card);
    card = null;
  }

  function hideComment() {
    if (commentButton && commentButton.parentNode) commentButton.parentNode.removeChild(commentButton);
    commentButton = null;
  }

  /** Opens the note card at (x, y); `build(note)` returns the prompt to queue. */
  function openCard(x, y, label, build) {
    closeCard();
    hideComment();
    ensureStyle();
    card = document.createElement("div");
    card.className = "my-lavish-card";
    card.setAttribute(UI_ATTR, "");
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-label", "Note for the agent");

    var heading = document.createElement("div");
    heading.className = "my-lavish-card-label";
    heading.textContent = label;

    var textarea = document.createElement("textarea");
    textarea.placeholder = "Note for the agent (Enter to queue)";

    var actions = document.createElement("div");
    actions.className = "my-lavish-card-actions";
    var cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    var queue = document.createElement("button");
    queue.type = "button";
    queue.className = "my-lavish-primary";
    queue.textContent = "Queue";
    actions.appendChild(cancel);
    actions.appendChild(queue);

    card.appendChild(heading);
    card.appendChild(textarea);
    card.appendChild(actions);

    function submit() {
      var note = textarea.value.trim();
      if (!note) {
        textarea.focus();
        return;
      }
      post({ type: "queuePrompt", prompt: build(note) });
      closeCard();
    }

    queue.addEventListener("click", submit);
    cancel.addEventListener("click", closeCard);
    textarea.addEventListener("keydown", function (event) {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        submit();
      } else if (event.key === "Escape" && textarea.value.trim() === "") {
        event.preventDefault();
        closeCard();
      }
    });

    document.body.appendChild(card);
    var width = card.offsetWidth || 280;
    var height = card.offsetHeight || 150;
    card.style.left = clamp(x + 8, 8, Math.max(8, window.innerWidth - width - 8)) + "px";
    card.style.top = clamp(y + 8, 8, Math.max(8, window.innerHeight - height - 8)) + "px";
    textarea.focus();
  }

  function openElementCard(el, x, y) {
    var tag = el.tagName.toLowerCase();
    var selector = cssSelector(el);
    var text = elementText(el);
    openCard(x, y, "Note on " + tag, function (note) {
      return { prompt: note, tag: tag, selector: selector, text: text };
    });
  }

  function openSelectionCard(selection, x, y) {
    openCard(x, y, "Note on selected text", function (note) {
      return {
        prompt: note,
        tag: "text",
        selector: selection.selector,
        text: selection.text,
        target: { type: "text-range", text: selection.text, selector: selection.selector },
      };
    });
  }

  function showComment() {
    hideComment();
    if (ended) return;
    var sel = window.getSelection && window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
    var text = sel.toString().trim();
    if (!text) return;
    var range = sel.getRangeAt(0);
    var ancestor = range.commonAncestorContainer;
    if (!isElement(ancestor)) ancestor = ancestor.parentElement;
    if (!ancestor || isUi(ancestor)) return;
    var active = document.activeElement;
    if (active && active.matches && active.matches("input, textarea, [contenteditable], [contenteditable] *")) return;

    closeCard(); // a double-click leaves the first element card open
    pendingSelection = { text: text, selector: cssSelector(ancestor) };
    var rect = range.getBoundingClientRect();
    ensureStyle();
    commentButton = document.createElement("button");
    commentButton.type = "button";
    commentButton.className = "my-lavish-comment";
    commentButton.setAttribute(UI_ATTR, "");
    commentButton.textContent = "Comment";
    commentButton.style.left = clamp(rect.right - 40, 8, Math.max(8, window.innerWidth - 90)) + "px";
    commentButton.style.top = clamp(rect.bottom + 6, 8, Math.max(8, window.innerHeight - 36)) + "px";
    commentButton.addEventListener("mousedown", function (event) {
      event.preventDefault(); // keep the selection while clicking
    });
    commentButton.addEventListener("click", function () {
      var selection = pendingSelection;
      var box = commentButton.getBoundingClientRect();
      if (selection) openSelectionCard(selection, box.left, box.bottom);
    });
    document.body.appendChild(commentButton);
  }

  // ---- hover outline -------------------------------------------------------

  function clearHover() {
    if (!hovered) return;
    restoreOutline(hovered.el, hovered.outline);
    hovered = null;
  }

  /** Restores only the outline property, leaving other inline style changes alone. */
  function restoreOutline(el, outline) {
    el.style.outline = outline;
    if (el.getAttribute("style") === "") el.removeAttribute("style");
  }

  function setHover(el) {
    if (hovered && hovered.el === el) return;
    clearHover();
    hovered = { el: el, outline: el.style.outline };
    el.style.outline = HOVER_OUTLINE;
  }

  document.addEventListener("mouseover", function (event) {
    if (!annotate) return;
    if (isAnnotatable(event.target)) setHover(event.target);
    else clearHover();
  }, true);

  document.addEventListener("mouseout", function (event) {
    if (!event.relatedTarget) clearHover(); // pointer left the page
  }, true);

  // ---- annotate clicks, selection, shortcuts -------------------------------

  window.addEventListener("click", function (event) {
    if (!annotate || event.button !== 0) return;
    var target = event.target;
    if (!isAnnotatable(target)) return;
    var sel = window.getSelection && window.getSelection();
    if (sel && !sel.isCollapsed && sel.toString().trim()) return; // a text selection, not a click
    event.preventDefault();
    event.stopPropagation();
    openElementCard(target, event.clientX, event.clientY);
  }, true);

  window.addEventListener("mousedown", function (event) {
    if (!isUi(event.target)) hideComment();
  }, true);

  window.addEventListener("mouseup", function (event) {
    if (isUi(event.target)) return;
    setTimeout(showComment, 0); // let the selection settle first
  }, true);

  window.addEventListener("keydown", function (event) {
    if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey
        && (event.key === "i" || event.key === "I")) {
      event.preventDefault();
      event.stopPropagation();
      setAnnotate(!annotate);
    }
  }, true);

  function setAnnotate(on) {
    annotate = Boolean(on);
    if (!annotate) clearHover();
    post({ type: "mode", annotate: annotate });
  }

  // ---- scroll, snapshot, ready ---------------------------------------------

  window.addEventListener("scroll", function () {
    hideComment();
    if (scrollTimer) return;
    scrollTimer = setTimeout(function () {
      scrollTimer = null;
      post({ type: "scroll", x: window.scrollX, y: window.scrollY });
    }, SCROLL_THROTTLE_MS);
  }, { passive: true });

  function childPath(el) {
    var path = [];
    for (var node = el; node && node !== document.documentElement; node = node.parentElement) {
      path.unshift(Array.prototype.indexOf.call(node.parentElement.children, node));
    }
    return path;
  }

  /** The page's HTML without the SDK's own script tag, UI, styles or hover outline. */
  function snapshot() {
    // Import into an inert document so nothing in the copy loads or runs.
    var inert = document.implementation.createHTMLDocument("");
    var root = inert.importNode(document.documentElement, true);
    if (hovered && hovered.el.isConnected) {
      var copy = root;
      var path = childPath(hovered.el);
      for (var i = 0; copy && i < path.length; i++) copy = copy.children[path[i]];
      if (copy) restoreOutline(copy, hovered.outline);
    }
    var injected = root.querySelectorAll("[" + UI_ATTR + "], script[src]");
    for (var j = 0; j < injected.length; j++) {
      var node = injected[j];
      if (node.localName === "script" && !/^\/sdk\.js(\?|$)/.test(node.getAttribute("src") || "")) continue;
      if (node.parentNode) node.parentNode.removeChild(node);
    }
    return root.outerHTML.slice(0, MAX_SNAPSHOT_CHARS);
  }

  function announceReady() {
    post({ type: "ready" });
    post({ type: "mode", annotate: annotate });
  }

  if (document.readyState === "complete") announceReady();
  else window.addEventListener("load", announceReady);

  // ---- public API ----------------------------------------------------------

  window.lavish = {
    /** Queues a prompt for the agent; `options.element` anchors it, `options.data` rides along. */
    queuePrompt: function (text, options) {
      var note = typeof text === "string" ? text.trim() : "";
      if (!note) return false;
      var opts = options || {};
      var prompt = { prompt: note, tag: "chat", selector: "", text: "" };
      if (isElement(opts.element)) {
        prompt.tag = opts.element.tagName.toLowerCase();
        prompt.selector = cssSelector(opts.element);
        prompt.text = elementText(opts.element);
      }
      if (opts.data !== undefined) {
        var data = toPlainData(opts.data);
        if (data !== undefined) prompt.target = { type: "data", data: data };
      }
      post({ type: "queuePrompt", prompt: prompt });
      return framed;
    },
    setAnnotate: function (on) {
      setAnnotate(on);
    },
  };
})();
