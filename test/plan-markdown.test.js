import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensurePlanHtml, generatedSourceFor, renderPlanHtml } from "../src/plan-markdown.js";

async function tmp(t) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "mla-md-"));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  return dir;
}

const newer = async (p) => {
  const t = new Date(Date.now() + 5000);
  await fs.promises.utimes(p, t, t);
};

test("renders headings, tables, task lists and code", () => {
  const html = renderPlanHtml("# Plan\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- [ ] step\n\n```js\nx\n```", { title: "plan" });
  assert.match(html, /<title>Plan<\/title>/);
  assert.match(html, /<table>/);
  assert.match(html, /type="checkbox"/);
  assert.match(html, /<pre><code class="language-js">/);
  assert.match(html, /content="see-plan"/);
});

test("writes html when missing", async (t) => {
  const md = path.join(await tmp(t), "plan.md");
  await fs.promises.writeFile(md, "# Hi");
  const r = await ensurePlanHtml(md);
  assert.equal(r.wrote, true);
  assert.ok(fs.existsSync(path.join(path.dirname(md), "plan.html")));
});

test("regenerates its own html when md is newer", async (t) => {
  const md = path.join(await tmp(t), "plan.md");
  await fs.promises.writeFile(md, "# One");
  await ensurePlanHtml(md);
  await fs.promises.writeFile(md, "# Two");
  await newer(md);
  const r = await ensurePlanHtml(md);
  assert.equal(r.wrote, true);
  assert.match(await fs.promises.readFile(r.htmlPath, "utf8"), /Two/);
});

test("never overwrites a hand-written html", async (t) => {
  const md = path.join(await tmp(t), "plan.md");
  const html = path.join(path.dirname(md), "plan.html");
  await fs.promises.writeFile(html, "<html>mine</html>");
  await fs.promises.writeFile(md, "# Hi");
  await newer(md);
  const r = await ensurePlanHtml(md);
  assert.equal(r.wrote, false);
  assert.equal(await fs.promises.readFile(html, "utf8"), "<html>mine</html>");
});

test("missing md is a VALIDATION_ERROR", async (t) => {
  const md = path.join(await tmp(t), "nope.md");
  await assert.rejects(ensurePlanHtml(md), { code: "VALIDATION_ERROR" });
});

test("generatedSourceFor finds the sibling md", async (t) => {
  const dir = await tmp(t);
  const md = path.join(dir, "plan.md");
  await fs.promises.writeFile(md, "# Hi");
  const { htmlPath } = await ensurePlanHtml(md);
  assert.equal(await generatedSourceFor(htmlPath), md);

  const hand = path.join(dir, "hand.html");
  await fs.promises.writeFile(hand, "<html></html>");
  await fs.promises.writeFile(path.join(dir, "hand.md"), "x");
  assert.equal(await generatedSourceFor(hand), null);

  const lonely = path.join(dir, "lonely.html");
  await fs.promises.writeFile(lonely, renderPlanHtml("# x", { title: "x" }));
  assert.equal(await generatedSourceFor(lonely), null);
});
