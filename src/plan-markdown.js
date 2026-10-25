import fs from "node:fs";
import path from "node:path";
import { marked } from "marked";
import { escapeHtml } from "./markdown.js";

const GENERATOR_META = '<meta name="generator" content="see-plan">';

const STYLE = `
body{font:16px/1.6 system-ui,sans-serif;max-width:760px;margin:2rem auto;padding:0 1rem;color:#1b1f24}
h1,h2,h3{line-height:1.25}
table{border-collapse:collapse;width:100%;margin:1rem 0}
th,td{border:1px solid #c8ccd0;padding:.4rem .6rem;text-align:left}
pre{background:#f4f5f6;padding:.75rem;overflow:auto;border-radius:6px}
code{font-family:ui-monospace,Consolas,monospace;font-size:.9em}
li input[type=checkbox]{margin-right:.4rem}
blockquote{border-left:4px solid #c8ccd0;margin-left:0;padding-left:1rem;color:#555}
`.trim();

function validationError(message) {
  const err = new Error(message);
  err.code = "VALIDATION_ERROR";
  return err;
}

export function isMarkdownPath(p) {
  return /\.(md|markdown)$/i.test(p);
}

export function htmlPathFor(mdPath) {
  const { dir, name } = path.parse(mdPath);
  return path.join(dir, `${name}.html`);
}

export function renderPlanHtml(markdown, { title }) {
  const heading = /^# +(.+)$/m.exec(markdown);
  const docTitle = (heading ? heading[1] : title).trim();
  const body = marked.parse(markdown, { gfm: true });
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
${GENERATOR_META}
<title>${escapeHtml(docTitle)}</title>
<style>
${STYLE}
</style>
</head>
<body>
${body}
</body>
</html>
`;
}

async function statOrNull(p) {
  return fs.promises.stat(p).catch(() => null);
}

async function isGenerated(htmlPath) {
  try {
    return (await fs.promises.readFile(htmlPath, "utf8")).includes(GENERATOR_META);
  } catch {
    return false;
  }
}

export async function ensurePlanHtml(mdPath) {
  const mdStat = await statOrNull(mdPath);
  if (!mdStat?.isFile()) throw validationError(`File not found: ${mdPath}`);
  const htmlPath = htmlPathFor(mdPath);
  const htmlStat = await statOrNull(htmlPath);
  const stale = htmlStat && mdStat.mtimeMs > htmlStat.mtimeMs && (await isGenerated(htmlPath));
  if (htmlStat && !stale) return { htmlPath, wrote: false };
  const markdown = await fs.promises.readFile(mdPath, "utf8");
  await fs.promises.writeFile(htmlPath, renderPlanHtml(markdown, { title: path.parse(mdPath).name }));
  return { htmlPath, wrote: true };
}

export async function generatedSourceFor(htmlPath) {
  if (!(await isGenerated(htmlPath))) return null;
  const { dir, name } = path.parse(htmlPath);
  for (const ext of [".md", ".markdown"]) {
    const candidate = path.join(dir, name + ext);
    if ((await statOrNull(candidate))?.isFile()) return candidate;
  }
  return null;
}
