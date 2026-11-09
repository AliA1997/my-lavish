/* see-plan output renderer: Mermaid diagrams and image regions inside the sandboxed frame.
 * Classic script, no storage APIs (the frame has an opaque origin). It only sets data-see-plan-target
 * on elements; the SDK reads that attribute when a note is taken. */
(function () {
  "use strict";

  function renderMermaid() {
    var blocks = document.querySelectorAll("code.language-mermaid");
    Array.prototype.forEach.call(blocks, function (code) {
      var pre = document.createElement("pre");
      pre.className = "mermaid";
      pre.textContent = code.textContent;
      var old = code.parentElement && code.parentElement.localName === "pre" ? code.parentElement : code;
      old.parentNode.replaceChild(pre, old);
    });
    if (!document.querySelector("pre.mermaid") || !window.mermaid) return;
    window.mermaid.initialize({ startOnLoad: false, securityLevel: "strict" });
    window.mermaid.run({ querySelector: "pre.mermaid" }).then(tagNodes, function (e) {
      var note = document.createElement("p");
      note.className = "see-plan-render-error";
      note.textContent = "This diagram could not be drawn: " + (e && e.message ? e.message : e);
      document.body.insertBefore(note, document.body.firstChild);
    });
  }

  /** Clicking a node notes that node (M3). */
  function tagNodes() {
    Array.prototype.forEach.call(document.querySelectorAll("pre.mermaid svg .node[id]"), function (node) {
      node.setAttribute("data-see-plan-target", JSON.stringify({ node: node.id.replace(/^mermaid-\d+-/, "") }));
    });
  }

  /** A click is a point, a drag a box, in percent of the image: mouseup runs before the SDK's click handler. */
  function watchImage(img) {
    var start = null;
    function at(event) {
      var r = img.getBoundingClientRect();
      var clamp = function (v) { return Math.min(100, Math.max(0, Math.round(v * 10) / 10)); };
      return { x: clamp(((event.clientX - r.left) / r.width) * 100), y: clamp(((event.clientY - r.top) / r.height) * 100) };
    }
    img.addEventListener("mousedown", function (event) { start = at(event); });
    img.addEventListener("mouseup", function (event) {
      if (!start) return;
      var end = at(event);
      img.setAttribute("data-see-plan-target", JSON.stringify({
        x: Math.min(start.x, end.x),
        y: Math.min(start.y, end.y),
        w: Math.round(Math.abs(end.x - start.x) * 10) / 10,
        h: Math.round(Math.abs(end.y - start.y) * 10) / 10,
      }));
      start = null;
    });
  }

  renderMermaid();
  var img = document.querySelector("img.image");
  if (img) watchImage(img);
})();
