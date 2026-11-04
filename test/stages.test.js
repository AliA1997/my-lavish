import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { canRelabel, inferStageFromPath, inferStageFromText, resolveStage, stageInstructions, stageStep } from "../src/stages.js";
import { SessionStore } from "../src/session-store.js";

const TEXT_CASES = [
  ["this is the interrogation", "interrogation"],
  ["grill me on this plan", "interrogation"],
  ["Time for the interrogation stage", "interrogation"],
  ["please poke holes in it", "interrogation"],
  ["stress-test the plan", "interrogation"],
  ["let's implement it", "implementation"],
  ["Let\u2019s build it now", "implementation"],
  ["start implementing task 1", "implementation"],
  ["this is the implementation", "implementation"],
  ["verify the build", "verification"],
  ["let's verify", "verification"],
  ["Now the verification", "verification"],
  ["run the acceptance checks", "verification"],
  ["here's the plan", "plan"],
  ["write a plan for auth", "plan"],
  ["this is the planning session", "plan"],
  ["I plan to eat", null],
  ["the plan looks fine", null],
  ["make the title bigger", null],
  ["", null],
  ["building codes are boring", null],
];

test("inferStageFromText needs a stage phrase", () => {
  for (const [text, expected] of TEXT_CASES) assert.equal(inferStageFromText(text), expected, text);
});

test("inferStageFromPath", () => {
  assert.equal(inferStageFromPath("/x/auth.plan.md"), "plan");
  assert.equal(inferStageFromPath("C:\\x\\auth-interrogation.html"), "interrogation");
  assert.equal(inferStageFromPath("verify-report.html"), "verification");
  assert.equal(inferStageFromPath("auth.progress.html"), "implementation");
  assert.equal(inferStageFromPath("notes.html"), null);
  assert.equal(inferStageFromPath("planet.html"), null);
});

test("resolveStage follows flag → human → text → path → workflow", () => {
  const all = { flag: "verification", human: "plan", text: "let's implement it", path: "a-interrogation.html", workflow: "plan" };
  assert.deepEqual(resolveStage(all), { stage: "verification", source: "flag" });
  assert.deepEqual(resolveStage({ ...all, flag: undefined }), { stage: "plan", source: "human" });
  assert.deepEqual(resolveStage({ ...all, flag: undefined, human: undefined }), { stage: "implementation", source: "text" });
  assert.deepEqual(resolveStage({ path: "a-interrogation.html", workflow: "plan" }), { stage: "interrogation", source: "path" });
  assert.deepEqual(resolveStage({ workflow: "plan" }), { stage: "plan", source: "workflow" });
  assert.deepEqual(resolveStage({}), { stage: null, source: null });
});

test("canRelabel never lets inference beat a human or flag label", () => {
  for (const weak of ["text", "path", "workflow"]) {
    assert.equal(canRelabel("human", weak), false);
    assert.equal(canRelabel("flag", weak), false);
  }
  assert.equal(canRelabel("human", "flag"), true);
  assert.equal(canRelabel("path", "text"), true);
  assert.equal(canRelabel("text", "path"), false);
  assert.equal(canRelabel(null, "workflow"), true);
});

test("store: human label wins over inference", async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "mla-stage-"));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const store = new SessionStore(dir);
  const { session } = await store.upsertSession(path.join(dir, "auth.plan.html"), "http://x");
  assert.deepEqual([session.stage, session.stage_source], ["plan", "path"], "the file name labels a new session");
  assert.equal((await store.setStage(session.key, "interrogation", "human")).changed, true);
  const r = await store.setStage(session.key, "implementation", "text");
  assert.deepEqual([r.changed, r.stage, r.stage_source], [false, "interrogation", "human"]);
  assert.equal((await store.setStage(session.key, "verification", "flag")).stage, "verification");
  await assert.rejects(store.setStage(session.key, "bogus", "human"), { code: "VALIDATION_ERROR" });
});

test("stage text names the files and forbids starting the next stage", () => {
  const i = stageInstructions("interrogation", { requirements: "r.md", plan: "p.md", artifact: "q.html" });
  assert.match(i, /numbered questions, each with a recommended answer/);
  assert.match(i, /q\.html/);
  assert.match(i, /Do not start the next stage yourself/);
  assert.match(stageStep("verification"), /do not fix code/);
  assert.equal(stageStep(null), "");
});
