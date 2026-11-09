import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createServer, rawFetch } from "./helpers/authed-server.js";
import { createPollOutput, outputsStep, splitOutputs } from "../src/cli.js";
import { MAX_CSV_ROWS, MAX_OUTPUTS, kindOf, outputIdFor, outputsOf, parseCsv, placeholderPage, promptOutput, renderOutputPage, withMermaid } from "../src/outputs.js";
import { listOutputRevisions, readOutputRevision, saveOutputRevision } from "../src/revisions.js";
import { SessionStore, StoreError } from "../src/session-store.js";

async function tmp(t) {
  const dir = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), "mla-out-")));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  return dir;
}

async function startServer(t) {
  const dir = await tmp(t);
  const stateDir = path.join(dir, "state");
  const store = new SessionStore(stateDir);
  const srv = createServer({ store, stateDir, port: 0, idleTimeoutMs: 0, version: "t", claudeDir: path.join(dir, "claude"), errorLogFile: path.join(dir, "e.json") });
  const { port } = await srv.listen();
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${port}`;
  const post = (p, body, headers = {}) => fetch(`${base}${p}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { dir, store, base, post, srv, port };
}

test("kinds, ids and the session view", () => {
  assert.deepEqual(["a.HTML", "b.md", "c.mmd", "d.svg", "e.csv", "f.exe"].map(kindOf), ["html", "markdown", "mermaid", "image", "text", null]);
  assert.equal(outputIdFor("/x/Flow Chart.mmd"), "flow-chart-mmd");
  assert.equal(outputIdFor("/x/a.png", ["a-png"]), "a-png-2");
  assert.equal(outputIdFor("/x/main"), "main-2", "main stays the primary's");
  const old = { file: "/p/a.html", revision: 3 };
  assert.deepEqual(outputsOf(old).map((o) => [o.id, o.kind, o.revision]), [["main", "html", 3]], "a pre-4.0 session is one output");
  assert.equal(old.outputs, undefined, "nothing is rewritten");
  assert.equal(outputsOf({ file: "/p/a.html", source_file: "/p/a.md" })[0].file, "/p/a.md");
  assert.equal(promptOutput(old, "main"), undefined, "a single-output review has no tag");
  const two = { file: "/p/a.html", outputs: [{ id: "x", file: "/p/x.png", kind: "image" }] };
  assert.deepEqual(promptOutput(two, "x"), { id: "x", file: "/p/x.png", kind: "image" });
  assert.equal(promptOutput(two, "nope"), undefined);
});

test("splitOutputs: the first html/md is primary; unknown kinds and no primary are refused", () => {
  assert.deepEqual(splitOutputs(["f.mmd", "p.md", "x.html", "f.mmd"]), { primary: "p.md", extras: ["f.mmd", "x.html"] });
  assert.throws(() => splitOutputs(["a.exe", "p.md"]), /can't show/);
  assert.throws(() => splitOutputs(["a.png"]), /at least one .html or .md/);
});

test("CSV parsing and rendering: quotes, newlines, escaping and the row cap", () => {
  assert.deepEqual(parseCsv('a,b\r\n"x,""y""","l1\nl2"\n'), [["a", "b"], ['x,"y"', "l1\nl2"]]);
  const html = renderOutputPage({ kind: "text", file: "t.csv", text: 'a,b\n<script>x</script>,2\n' });
  assert.ok(html.includes("&lt;script&gt;x"), "cells are escaped");
  assert.ok(!html.includes("<script>x"));
  assert.ok(/data-see-plan-target="\{&quot;row&quot;:2\}"/.test(html));
  const big = renderOutputPage({ kind: "text", file: "t.csv", text: Array.from({ length: MAX_CSV_ROWS + 10 }, (_, i) => `r${i}`).join("\n") });
  assert.ok(big.includes(`first ${MAX_CSV_ROWS} of ${MAX_CSV_ROWS + 10}`));
  assert.ok(!big.includes(`r${MAX_CSV_ROWS + 1}<`));
});

test("text, JSON, images and placeholders render safely", () => {
  const log = renderOutputPage({ kind: "text", file: "a.log", text: "one\n<b>two</b>\n" });
  assert.ok(log.includes('id="L2"') && log.includes("&lt;b&gt;two"));
  assert.ok(renderOutputPage({ kind: "text", file: "a.json", text: '{"a":1}' }).includes("&quot;a&quot;: 1"), "JSON is pretty-printed");
  assert.ok(renderOutputPage({ kind: "text", file: "a.json", text: "{bad" }).includes("{bad"), "bad JSON is shown as written");
  const svg = renderOutputPage({ kind: "image", file: "x.svg", imageSrc: "__raw" });
  assert.ok(svg.includes('<img class="image"') && !svg.includes("<svg"), "an SVG is never inlined");
  const mm = renderOutputPage({ kind: "mermaid", file: "f.mmd", text: "graph TD; A-->B</pre><script>x</script>" });
  assert.ok(mm.includes('<pre class="mermaid">') && !mm.includes("<script>x"), "the diagram source is escaped");
  assert.ok(!/https?:\/\//.test(mm), "nothing loads from a CDN");
  assert.ok(placeholderPage("/a/big.log", 6 * 1024 * 1024, 5 * 1024 * 1024).includes("6.0 MB"));
  assert.ok(withMermaid('<body><code class="language-mermaid">x</code></body>').includes("mermaid.min.js"));
  assert.equal(withMermaid("<body>plain</body>"), "<body>plain</body>");
});

test("store: unique ids, the cap, other sessions, removal", async (t) => {
  const dir = await tmp(t);
  const store = new SessionStore(path.join(dir, "s"));
  const a = (await store.upsertSession(path.join(dir, "a.html"), "http://x")).session;
  const b = (await store.upsertSession(path.join(dir, "b.html"), "http://x")).session;
  const add = (key, ...names) => store.addOutputs(key, names.map((n) => ({ file: path.join(dir, n), kind: "text" })));
  const first = await add(a.key, "one.txt", "sub-one.txt");
  assert.deepEqual(first.added.map((o) => o.id), ["one-txt", "sub-one-txt"]);
  assert.equal((await add(a.key, "one.txt")).added.length, 0, "the same file keeps its output");
  await assert.rejects(add(b.key, "one.txt"), (e) => e instanceof StoreError && e.code === "OUTPUT_IN_OTHER_SESSION");
  await assert.rejects(add(b.key, "a.html"), (e) => e.code === "OUTPUT_IN_OTHER_SESSION", "another review's primary too");
  await add(a.key, ...Array.from({ length: MAX_OUTPUTS - 3 }, (_, i) => `f${i}.txt`));
  await assert.rejects(add(a.key, "over.txt"), /at most 12/);
  await store.removeOutput(a.key, "one-txt");
  assert.equal(outputsOf(await store.getSession(a.key)).length, MAX_OUTPUTS - 1);
  await assert.rejects(store.removeOutput(a.key, "main"), /primary/);
  await store.endSession(a.key, "user");
  assert.equal((await add(b.key, "sub-one.txt")).added.length, 1, "an ended review doesn't hold its files");
});

test("output revisions: saved per output, capped, and readable", async (t) => {
  const dir = await tmp(t);
  const file = path.join(dir, "a.mmd");
  const key = "0123456789abcdef";
  for (let n = 0; n < 23; n++) {
    await fs.promises.writeFile(file, `v${n}`);
    await saveOutputRevision(dir, key, "a-mmd", n, file);
  }
  const list = await listOutputRevisions(dir, key, "a-mmd");
  assert.equal(list.length, 20);
  assert.equal(list[0].n, 3);
  assert.equal((await readOutputRevision(dir, key, "a-mmd", 22)).toString(), "v22");
  assert.equal(await readOutputRevision(dir, key, "a-mmd", 1), null);
  await assert.rejects(listOutputRevisions(dir, key, "../x"), /invalid output id/);
});

test("server: outputs are added, served by capability, tagged on notes, and reload on their own", async (t) => {
  const { dir, base, post } = await startServer(t);
  const write = (n, c) => fs.promises.writeFile(path.join(dir, n), c).then(() => path.join(dir, n));
  const primary = await write("plan.html", "<html><body>plan</body></html>");
  const flow = await write("flow.mmd", "graph TD; A-->B");
  const shot = await write("x.svg", '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  const log = await write("a.log", "line one\n");
  const notes = await write("notes.md", "# Notes\n\n```mermaid\ngraph TD; A-->B\n```\n");
  await fs.promises.mkdir(path.join(dir, "other"));
  await write("other/secret.txt", "nope");

  const opened = await (await post("/api/sessions", { file: primary })).json();
  const { key } = opened;
  assert.deepEqual(opened.outputs.map((o) => o.id), ["main"]);
  const added = await (await post(`/api/${key}/outputs`, { files: [flow, shot, log, notes] })).json();
  assert.deepEqual(added.added, ["flow-mmd", "x-svg", "a-log", "notes-md"]);

  assert.equal((await post(`/api/${key}/outputs`, { files: [path.join(dir, "a.exe")] })).status, 400, "unknown kind");
  assert.equal((await post(`/api/${key}/outputs`, { files: [path.join(dir, "gone.txt")] })).status, 400, "missing file");

  const page = await (await fetch(`${base}/session/${key}`)).text();
  const cap = /artifact\/[0-9a-f]{16}\/([0-9a-f]{32})\/index\.html/.exec(page)[1];
  const art = (rest) => `${base}/artifact/${key}/${cap}/o/${rest}`;

  const mm = await rawFetch(art("flow-mmd/index.html"));
  assert.equal(mm.status, 200, "the capability alone opens it");
  assert.match(mm.headers.get("content-security-policy"), /sandbox allow-scripts/);
  const mmHtml = await mm.text();
  assert.ok(mmHtml.includes("/vendor/mermaid.min.js") && mmHtml.includes("/sdk.js"));
  assert.equal((await rawFetch(`${base}/artifact/${key}/${"0".repeat(32)}/o/flow-mmd/index.html`)).status, 404, "a wrong capability");
  assert.equal((await rawFetch(art("nope/index.html"))).status, 404);
  assert.equal((await rawFetch(art("main/index.html"))).status, 404, "the primary has its own route");

  const raw = await rawFetch(art("x-svg/__raw"));
  assert.equal(raw.headers.get("content-type").split(";")[0], "image/svg+xml");
  assert.match(raw.headers.get("content-security-policy"), /script-src 'none'/);
  assert.equal((await rawFetch(art("a-log/__raw"))).status, 404, "raw bytes are for images");
  assert.ok((await (await rawFetch(art("notes-md/index.html"))).text()).includes("/vendor/mermaid.min.js"), "mermaid blocks in Markdown get drawn");
  assert.equal((await rawFetch(art("a-log/other/secret.txt"))).status, 200, "assets next to the output resolve");
  assert.equal((await rawFetch(art("a-log/..%2F..%2Fetc"))).status, 404);
  assert.equal((await rawFetch(`${base}/vendor/mermaid.min.js`)).status, 200, "the bundle is served locally");

  // A note on an output comes back tagged; an unknown id is dropped.
  const origin = { origin: base };
  assert.equal((await post(`/api/${key}/prompts`, {
    prompts: [
      { prompt_id: "1", prompt: "fix node", tag: "g", selector: "#n", text: "", output: "flow-mmd", target: { node: "flowchart-A-0" } },
      { prompt_id: "2", prompt: "other", tag: "p", selector: "p", text: "", output: "nope" },
    ],
    dom_snapshot: "",
  }, origin)).status, 200);
  const polled = await (await post("/api/poll", { file: primary, timeoutMs: 2000 })).json();
  assert.deepEqual(polled.prompts[0].output, { id: "flow-mmd", file: flow, kind: "mermaid" });
  assert.deepEqual(polled.prompts[0].target, { node: "flowchart-A-0" });
  assert.equal(polled.prompts[1].output, undefined);
  const out = createPollOutput({ file: primary, response: polled, errorLogFile: "e" });
  assert.match(out.next_step, /1 note on `flow\.mmd`/);

  // Editing one output bumps only that output, and its revision is readable.
  await fs.promises.writeFile(flow, "graph TD; A-->C");
  let revs;
  for (let i = 0; i < 50; i++) {
    revs = await (await fetch(`${base}/api/${key}/revisions?output=flow-mmd`)).json();
    if (revs.revision >= 1) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(revs.revision, 1);
  assert.equal((await (await fetch(`${base}/api/${key}/revisions`)).json()).revision, 0, "the primary didn't change");
  const old = await (await fetch(`${base}/api/${key}/revisions/0?output=flow-mmd`)).json();
  assert.ok(old.html.includes("A--&gt;B") && !old.html.includes("/sdk.js"), "an old revision is read-only");

  // Owner lookup and removal.
  const owner = await (await fetch(`${base}/api/outputs/owner?file=${encodeURIComponent(flow)}`)).json();
  assert.equal(owner.key, key);
  assert.equal((await post("/api/sessions", { file: notes.replace(/md$/, "html"), source_file: notes })).status, 409, "an output can't start its own review");
  assert.equal((await fetch(`${base}/api/${key}/outputs/flow-mmd`, { method: "DELETE" })).status, 200);
  assert.equal((await rawFetch(art("flow-mmd/index.html"))).status, 404);
  assert.equal((await rawFetch(`${base}/api/${key}/outputs/x-svg`, { method: "DELETE" })).status, 401, "changing outputs needs the token");
});

test("oversized outputs show a placeholder", async (t) => {
  const { dir, base, post } = await startServer(t);
  const primary = path.join(dir, "p.html");
  await fs.promises.writeFile(primary, "<body>p</body>");
  const big = path.join(dir, "big.log");
  await fs.promises.writeFile(big, Buffer.alloc(5 * 1024 * 1024 + 1, 97));
  const { key } = await (await post("/api/sessions", { file: primary })).json();
  await post(`/api/${key}/outputs`, { files: [big] });
  const cap = /artifact\/[0-9a-f]{16}\/([0-9a-f]{32})\//.exec(await (await fetch(`${base}/session/${key}`)).text())[1];
  const html = await (await rawFetch(`${base}/artifact/${key}/${cap}/o/big-log/index.html`)).text();
  assert.ok(html.includes("over the 5.0 MB limit") && !html.includes("aaaa"));
});

test("outputsStep is empty for a single-output review", () => {
  assert.equal(outputsStep([{ prompt: "x" }]), "");
});
