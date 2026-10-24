import { test } from "node:test";
import assert from "node:assert/strict";
import { escapeHtml, renderAgentMarkdown, serializeChat } from "../src/markdown.js";

test("escapeHtml", () => {
  assert.equal(escapeHtml(`&<>"'`), "&amp;&lt;&gt;&quot;&#39;");
});

test("paragraphs, bold, lists", () => {
  assert.equal(
    renderAgentMarkdown("Hi **there**\n\n- a\n- b"),
    "<p>Hi <strong>there</strong></p><ul><li>a</li><li>b</li></ul>",
  );
});

test("br, ol, heading, em, code", () => {
  assert.equal(renderAgentMarkdown("a\nb"), "<p>a<br>b</p>");
  assert.equal(renderAgentMarkdown("1. a\n2. b"), "<ol><li>a</li><li>b</li></ol>");
  assert.equal(renderAgentMarkdown("## T"), "<p><strong>T</strong></p>");
  assert.equal(renderAgentMarkdown("*i* `c`"), "<p><em>i</em> <code>c</code></p>");
});

test("fenced code is literal", () => {
  assert.equal(
    renderAgentMarkdown("```\n**x** <b>\n```"),
    "<pre><code>**x** &lt;b&gt;</code></pre>",
  );
  assert.equal(renderAgentMarkdown("`**x**`"), "<p><code>**x**</code></p>");
});

test("html in agent text is escaped", () => {
  const out = renderAgentMarkdown("<img src=x onerror=alert(1)>");
  assert.ok(out.includes("&lt;img"));
  assert.ok(!out.includes("<img"));
  assert.ok(!renderAgentMarkdown("<script>alert(1)</script>").includes("<script"));
});

test("links: only http(s)", () => {
  assert.ok(!renderAgentMarkdown("[x](javascript:alert(1))").includes("<a"));
  assert.equal(
    renderAgentMarkdown("[t](https://e.com/a?b=1&c=2)"),
    '<p><a href="https://e.com/a?b=1&amp;c=2" target="_blank" rel="noopener">t</a></p>',
  );
  const out = renderAgentMarkdown('[t](https://e.com/"onmouseover="x)');
  assert.ok(!out.includes('"onmouseover'));
  assert.ok(out.includes("&quot;"));
});

test("serializeChat", () => {
  const out = serializeChat([
    { role: "user", text: "<b>hi</b>", anchor: null, at: 1, prompt_id: "p" },
    { role: "agent", text: "**x**", at: 2 },
  ]);
  assert.equal(out[0].text, "<b>hi</b>");
  assert.ok(!("html" in out[0]));
  assert.equal(out[0].prompt_id, "p");
  assert.equal(out[1].html, "<p><strong>x</strong></p>");
  assert.ok(!("text" in out[1]));
});
