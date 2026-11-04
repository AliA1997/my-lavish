import path from "node:path";

/** The four stages of a feature, in order. A session's stage is one of these or null (a plain review). */
export const STAGES = ["plan", "interrogation", "implementation", "verification"];

export const STAGE_TITLES = {
  plan: "Plan",
  interrogation: "Interrogation",
  implementation: "Implementation",
  verification: "Verification",
};

/** Where a stage label came from, strongest first. */
export const STAGE_SOURCES = ["flag", "human", "text", "path", "workflow"];
const STRENGTH = { flag: 5, human: 4, text: 3, path: 2, workflow: 1 };

export const SESSION_FEEDBACK_CATEGORIES = ["wrong-direction", "too-slow", "broke-something", "ignored-notes", "great-job"];
export const CATEGORY_TITLES = {
  "wrong-direction": "Wrong direction",
  "too-slow": "Too slow",
  "broke-something": "Broke something",
  "ignored-notes": "Ignored my notes",
  "great-job": "Great job",
};

export const isStage = (s) => STAGES.includes(s);
export const isStageSource = (s) => STAGE_SOURCES.includes(s);

export function nextStage(stage) {
  const i = STAGES.indexOf(stage);
  return i >= 0 && i < STAGES.length - 1 ? STAGES[i + 1] : null;
}

// A stage needs a stage phrase, not any use of the word ("I plan to eat" is not a plan).
const TEXT_RULES = [
  ["interrogation", [
    /\b(this is|it'?s|start|begin|let'?s do|time for|on to|move (on )?to|now the) (the )?interrogation\b/,
    /\binterrogat(e|ion)\b.*\bplan\b/,
    /\bgrill (me|you|the plan|this|it)\b/,
    /\bpoke holes\b/,
    /\bstress[- ]test (the|this|my) plan\b/,
  ]],
  ["verification", [
    /\b(this is|it'?s|start|begin|time for|on to|move (on )?to|now the) (the )?verification\b/,
    /\b(let'?s|please|now|time to|go|can you) verify\b/,
    /\bverify (the|that|it|this|everything|all)\b/,
    /\brun the (acceptance|verification)\b/,
    /\bcheck (that )?it works\b/,
  ]],
  ["implementation", [
    /\b(this is|it'?s|start|begin|time for|on to|move (on )?to|now the) (the )?implementation\b/,
    /\blet'?s (implement|build|code)\b/,
    /\b(start|begin) (implementing|building|coding)\b/,
    /\bimplement (it|this|the plan|that)\b/,
    /\bgo build it\b/,
  ]],
  ["plan", [
    /\b(here'?s|here is|this is) (the|my|a|our) plan\b/,
    /\b(write|draft|create|make) (a|the|me a) plan\b/,
    /\b(this is|start|begin) (the )?planning\b/,
    /\bplanning (stage|session|phase)\b/,
  ]],
];

export function inferStageFromText(text) {
  const t = String(text ?? "").toLowerCase().replace(/[‘’]/g, "'");
  for (const [stage, rules] of TEXT_RULES) if (rules.some((r) => r.test(t))) return stage;
  return null;
}

export function inferStageFromPath(file) {
  const name = path.basename(String(file ?? "")).toLowerCase();
  if (/interrogat/.test(name)) return "interrogation";
  if (/verif/.test(name)) return "verification";
  if (/progress|implementation/.test(name)) return "implementation";
  if (/(^|[-_.])plan([-_.]|$)/.test(name)) return "plan";
  if (isPlanFolderPath(file)) return "plan";
  return null;
}

/** True when a file's parent folder is named `plans` or `specs` (docs/superpowers/plans/x.md and the like). */
export function isPlanFolderPath(file) {
  const parts = String(file ?? "").split(/[\\/]+/).filter(Boolean);
  const parent = parts.length > 1 ? parts[parts.length - 2].toLowerCase() : "";
  return parent === "plans" || parent === "specs";
}

/**
 * A session's stage for listing and classification: its label, or for an unlabeled session (one created before
 * path inference, never resumed since) the stage its path gives. Read-only: nothing is written back.
 */
export function effectiveStage(session) {
  if (isStage(session?.stage)) return session.stage;
  return inferStageFromPath(session?.source_file ?? session?.file);
}

/** D8: a file the Plans tab lists — in a plans/ or specs/ folder, or a New-feature `*.plan.md` file. */
export function isPlanFile(file) {
  return isPlanFolderPath(file) || /\.plan\.md$/i.test(String(file ?? ""));
}

/** Decision 4: flag → human → text → path → workflow. Returns { stage, source } or { stage: null, source: null }. */
export function resolveStage({ flag, human, text, path: file, workflow } = {}) {
  const candidates = [
    ["flag", isStage(flag) ? flag : null],
    ["human", isStage(human) ? human : null],
    ["text", text ? inferStageFromText(text) : null],
    ["path", file ? inferStageFromPath(file) : null],
    ["workflow", isStage(workflow) ? workflow : null],
  ];
  for (const [source, stage] of candidates) if (stage) return { stage, source };
  return { stage: null, source: null };
}

/** True when a label from `next` may replace one from `current`: inference never overwrites a human or flag label. */
export function canRelabel(current, next) {
  if (!current) return true;
  if (next === "flag" || next === "human") return true;
  return (STRENGTH[next] ?? 0) >= (STRENGTH[current] ?? 0);
}

/** What a stage's fresh Claude session is told to do (part of its launch prompt). */
export function stageInstructions(stage, { requirements, plan, artifact }) {
  const tail = "Do not start the next stage yourself; the human starts it from the page.";
  switch (stage) {
    case "plan":
      return `Read the requirements in ${requirements} and write the implementation plan to ${plan}, following \`see-plan playbook plan\`. ${tail}`;
    case "interrogation":
      return `Read ${plan}. Grill it: write numbered questions, each with a recommended answer, into ${artifact} following \`see-plan playbook interrogation\`. After the user answers, update ${plan}. ${tail}`;
    case "implementation":
      return `Implement ${plan} task by task. After each task, update ${artifact} following \`see-plan playbook progress\`. ${tail}`;
    case "verification":
      return `Verify the implementation of ${plan} against ${requirements}: run the tests and check each requirement. Record each acceptance criterion with pass/fail and evidence in ${artifact} following \`see-plan playbook verification\`. Do not fix code in this stage. ${tail}`;
    default:
      return "";
  }
}

/** The stage-specific part of poll's next_step (appended to the generic text). */
export function stageStep(stage, { planFile } = {}) {
  const plan = planFile ? `\`${planFile}\`` : "the plan";
  switch (stage) {
    case "plan":
      return "Stage: Plan. Keep the plan the single source of truth; the human approves it with Approve plan. Do not start the next stage yourself.";
    case "interrogation":
      return `Stage: Interrogation. Ask your questions in the artifact as numbered items with a recommended answer each; after the user answers, update ${plan} and poll again. Do not start implementing.`;
    case "implementation":
      return "Stage: Implementation. Work task by task and update the progress page after each task; report done in your reply. Do not start verification yourself.";
    case "verification":
      return "Stage: Verification. Check each acceptance criterion, record pass/fail with evidence on the verification page, and do not fix code in this stage; report findings.";
    default:
      return "";
  }
}
