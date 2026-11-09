import path from "node:path";
import { escapeHtml } from "./markdown.js";

/** M2: outputs per review session, the primary included. */
export const MAX_OUTPUTS = 12;
export const MAIN_OUTPUT = "main";
/** M3: bigger files show a placeholder with their size. */
export const MAX_OUTPUT_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_CSV_ROWS = 5000;
export const MERMAID_ASSET = "vendor/mermaid.min.js";
export const RENDER_ASSET = "output-render.js";

const KINDS = [
  ["html", /\.html?$/i],
  ["markdown", /\.(md|markdown)$/i],
  ["mermaid", /\.(mmd|mermaid)$/i],
  ["image", /\.(png|jpe?g|gif|webp|svg)$/i],
  ["text", /\.(txt|log|json|csv)$/i],
];

const IMAGE_TYPES = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml" };

/** The output kind for a file name, or null when see-plan cannot show it. */
export function kindOf(file) {
  const name = String(file);
  return KINDS.find(([, re]) => re.test(name))?.[0] ?? null;
}

export const maxBytesFor = (kind) => (kind === "image" ? MAX_IMAGE_BYTES : MAX_OUTPUT_BYTES);
export const imageType = (file) => IMAGE_TYPES[path.extname(String(file)).toLowerCase()] ?? "application/octet-stream";

/** A readable id from the file name, unique among `taken` ("main" stays the primary's). */
export function outputIdFor(file, taken = []) {
  const stem = path.basename(String(file).replace(/\\/g, "/")).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 56) || "output";
  const used = new Set([MAIN_OUTPUT, ...taken]);
  if (!used.has(stem)) return stem;
  for (let n = 2; ; n++) if (!used.has(`${stem}-${n}`)) return `${stem}-${n}`;
}

/** The primary file plus any added outputs. Sessions from before 4.0 read as one output, with nothing rewritten (M1). */
export function outputsOf(session) {
  const source = session.source_file;
  const main = { id: MAIN_OUTPUT, file: source ?? session.file, kind: source ? "markdown" : "html", revision: session.revision ?? 0, primary: true };
  return [main, ...(Array.isArray(session.outputs) ? session.outputs : [])];
}

export function getOutput(session, id) {
  return outputsOf(session).find((o) => o.id === id) ?? null;
}

/** M6: what a prompt carries; `undefined` for an unknown id or a session with a single output. */
export function promptOutput(session, id) {
  const all = outputsOf(session);
  if (all.length < 2) return undefined;
  const o = all.find((x) => x.id === id);
  return o ? { id: o.id, file: o.file, kind: o.kind } : undefined;
}

/** RFC 4180: quoted fields, doubled quotes, newlines inside quotes. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') field += c;
      else if (text[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = false;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const STYLE = `
body{font:14px/1.5 system-ui,sans-serif;margin:0;padding:1rem;color:#1b1f24;background:#fff}
.lines{font:13px/1.5 ui-monospace,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere}
.line{display:flex;gap:1rem}.line:hover{background:#f4f5f6}
.n{color:#6b7280;user-select:none;min-width:3.5em;text-align:right;flex:none}
table{border-collapse:collapse;font-size:13px}th,td{border:1px solid #c8ccd0;padding:.25rem .5rem;text-align:left;vertical-align:top}
th{background:#f4f5f6;position:sticky;top:0}
.note{color:#6b7280}.image{display:block;max-width:100%;height:auto;cursor:crosshair;-webkit-user-drag:none;user-select:none}
pre.mermaid{text-align:center;background:none}
.see-plan-render-error{color:#b42318;white-space:pre-wrap}
`.trim();

const target = (obj) => `data-see-plan-target="${escapeHtml(JSON.stringify(obj))}"`;

function page(title, body, scripts = "") {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head>
<body>${body}${scripts}</body></html>`;
}

function renderText(file, text) {
  if (/\.csv$/i.test(file)) {
    const rows = parseCsv(text);
    const [head = [], ...rest] = rows.slice(0, MAX_CSV_ROWS);
    const more = rows.length > MAX_CSV_ROWS ? `<p class="note">Showing the first ${MAX_CSV_ROWS} of ${rows.length} rows.</p>` : "";
    const cells = (r, tag) => r.map((c) => `<${tag}>${escapeHtml(c)}</${tag}>`).join("");
    return `${more}<table><thead><tr ${target({ row: 1 })}>${cells(head, "th")}</tr></thead><tbody>${rest.map((r, i) => `<tr ${target({ row: i + 2 })}>${cells(r, "td")}</tr>`).join("")}</tbody></table>`;
  }
  let shown = text;
  if (/\.json$/i.test(file)) {
    try {
      shown = JSON.stringify(JSON.parse(text), null, 2);
    } catch {} // invalid JSON is shown as written
  }
  const lines = shown.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n");
  return `<div class="lines">${lines.map((l, i) => `<div class="line" id="L${i + 1}" ${target({ line: i + 1 })}><span class="n">${i + 1}</span><span>${escapeHtml(l) || " "}</span></div>`).join("")}</div>`;
}

/** The scripts a page with Mermaid in it needs. Absolute paths: both live on this server, never a CDN (M3). */
const mermaidScripts = () => `<script src="/${MERMAID_ASSET}"></script><script src="/${RENDER_ASSET}"></script>`;

/**
 * The page for a `mermaid`, `image` or `text` output, without the SDK (a revision is read-only).
 * `imageSrc` is relative for the live page and a data: URL for a revision. An SVG only ever goes in <img>,
 * never inline, so its scripts cannot run.
 */
export function renderOutputPage({ kind, file, text = "", imageSrc = "" }) {
  const title = path.basename(String(file));
  if (kind === "image") {
    return page(title, `<img class="image" draggable="false" src="${escapeHtml(imageSrc)}" alt="${escapeHtml(title)}">`, `<script src="/${RENDER_ASSET}"></script>`);
  }
  if (kind === "mermaid") return page(title, `<pre class="mermaid">${escapeHtml(text)}</pre>`, mermaidScripts());
  return page(title, renderText(file, text));
}

export function placeholderPage(file, bytes, limit) {
  const mb = (n) => `${(n / (1024 * 1024)).toFixed(1)} MB`;
  const name = escapeHtml(path.basename(String(file)));
  return page(path.basename(String(file)), `<p class="note">${name} is ${mb(bytes)}, over the ${mb(limit)} limit, so it isn't shown here. Open it directly or attach a smaller version.</p>`);
}

/** Adds the Mermaid scripts to a page that has mermaid code blocks (Markdown renders them with this class). */
export function withMermaid(html) {
  if (!/class="language-mermaid"/.test(html)) return html;
  const tags = mermaidScripts();
  let idx = -1;
  for (const m of html.matchAll(/<\/body>/gi)) idx = m.index;
  return idx === -1 ? `${html}\n${tags}` : html.slice(0, idx) + tags + html.slice(idx);
}
