import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { StoreError } from "./session-store.js";
import { STAGES, STAGE_TITLES, nextStage } from "./stages.js";

const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const now = () => new Date().toISOString();

export const isFeatureName = (n) => typeof n === "string" && NAME.test(n) && !n.includes("..");

/** The artifact each stage's session reviews. */
export function stageFile(workflow, stage) {
  const base = path.join(workflow.dir, workflow.name);
  return {
    plan: `${base}.plan.md`,
    interrogation: `${base}.interrogation.html`,
    implementation: `${base}.progress.html`,
    verification: `${base}.verification.html`,
  }[stage];
}

export const requirementsFile = (dir, name) => path.join(dir, `${name}.requirements.md`);

function page(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>
:root{--bg:#fff;--fg:#1b1f24;--muted:#5b6470}
@media (prefers-color-scheme: dark){:root{--bg:#16181c;--fg:#e6e8eb;--muted:#9aa3ad}}
body{background:var(--bg);color:var(--fg);font:16px/1.6 system-ui,sans-serif;max-width:760px;margin:2rem auto;padding:0 1rem}
.muted{color:var(--muted)}
</style>
</head>
<body>
${body}
</body>
</html>
`;
}

/** Placeholder content written when a stage opens; the stage's Claude session replaces it. */
export function stageTemplate(workflow, stage) {
  const t = `${workflow.name} · ${STAGE_TITLES[stage]}`;
  switch (stage) {
    case "plan":
      return `# ${workflow.name}: plan\n\n_Claude is writing the plan from \`${path.basename(workflow.requirements_file)}\`…_\n`;
    case "interrogation":
      return page(t, `<h1>${t}</h1>\n<p class="muted">Claude is preparing numbered questions about the plan, each with a recommended answer…</p>`);
    case "implementation":
      return page(t, `<h1>${t}</h1>\n<p class="muted">Claude will list the plan's tasks here and update each one's status as it works.</p>`);
    case "verification":
      return page(t, `<h1>${t}</h1>\n<p class="muted">Claude will list each acceptance criterion here with pass/fail and evidence.</p>`);
    default:
      return "";
  }
}

function blankStages() {
  const out = {};
  for (const s of STAGES) out[s] = { status: s === "plan" ? "current" : "locked", key: null, claude_session_id: null };
  return out;
}

export function createWorkflow(store, { name, dir, requirements_file }) {
  return store.transact((state) => {
    state.workflows ??= {};
    const existing = Object.values(state.workflows).find((w) => w.name === name && w.dir === dir);
    if (existing) return [existing, false];
    const t = now();
    const wf = {
      id: crypto.randomBytes(6).toString("hex"),
      name,
      dir,
      requirements_file,
      stages: blankStages(),
      current: "plan",
      created_at: t,
      updated_at: t,
    };
    state.workflows[wf.id] = wf;
    return [wf, true];
  });
}

export function getWorkflow(store, id) {
  return store.transact((state) => [state.workflows?.[id] ?? null, false]);
}

/** By id, or the newest workflow with that name. */
export function findWorkflow(store, nameOrId) {
  return store.transact((state) => {
    const all = Object.values(state.workflows ?? {});
    return [all.find((w) => w.id === nameOrId) ?? all.filter((w) => w.name === nameOrId).at(-1) ?? null, false];
  });
}

export function listWorkflows(store) {
  return store.transact((state) => [Object.values(state.workflows ?? {}), false]);
}

function need(state, id) {
  const wf = state.workflows?.[id];
  if (!wf) throw new StoreError("MISSING", `no workflow ${id}`);
  return wf;
}

export function updateStage(store, id, stage, patch) {
  return store.transact((state) => {
    const wf = need(state, id);
    Object.assign(wf.stages[stage], patch);
    wf.updated_at = now();
    return [wf, true];
  });
}

/** Marks the current stage done (or skipped) and opens the next. Returns { workflow, next } (next is null at the end). */
export function advanceWorkflow(store, id, { from, skipped = false }) {
  return store.transact((state) => {
    const wf = need(state, id);
    if (from !== wf.current) throw new StoreError("NOT_CURRENT", `stage ${from} is not the current stage (${wf.current})`);
    wf.stages[from].status = skipped ? "skipped" : "done";
    const next = nextStage(from);
    if (next) {
      wf.stages[next].status = "current";
      wf.current = next;
    } else {
      wf.current = null;
      wf.completed_at = now();
    }
    wf.updated_at = now();
    return [{ workflow: wf, next }, true];
  });
}

/** A rejected verification sends the workflow back to implementation. */
export function reopenStage(store, id, stage) {
  return store.transact((state) => {
    const wf = need(state, id);
    const i = STAGES.indexOf(stage);
    for (const s of STAGES.slice(i)) wf.stages[s].status = s === stage ? "current" : "locked";
    wf.current = stage;
    delete wf.completed_at;
    wf.updated_at = now();
    return [wf, true];
  });
}

/** Writes the stage's artifact from its template unless the file already exists. */
export async function ensureStageFile(workflow, stage) {
  const file = stageFile(workflow, stage);
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  try {
    await fs.promises.writeFile(file, stageTemplate(workflow, stage), { flag: "wx" });
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
  }
  return file;
}
