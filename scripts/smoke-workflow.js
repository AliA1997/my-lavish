#!/usr/bin/env node
// Drives one feature through Plan → Interrogation → Implementation → Verification against a throwaway
// in-process server, with a fake Claude launcher and fake agent polls (no real Claude). Prints WORKFLOW SMOKE OK.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "../src/server.js";
import { SessionStore } from "../src/session-store.js";

function assert(cond, msg) {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "see-plan-wf-smoke-"));
const stateDir = path.join(tmp, "state");
const dir = path.join(tmp, "feature");
fs.mkdirSync(dir);
const launches = [];
const srv = createServer({
  store: new SessionStore(stateDir),
  stateDir,
  port: 0,
  version: "smoke",
  presenceGraceMs: 0,
  launchClaude: async (args) => {
    launches.push(args);
    return { mode: "powershell" };
  },
});

let failure = null;
try {
  const { baseUrl } = await srv.listen();
  const post = async (p, body, page = false) => {
    const res = await fetch(baseUrl + p, {
      method: "POST",
      headers: { "content-type": "application/json", ...(page ? { Origin: baseUrl } : {}) },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    assert(res.ok, `POST ${p} answered ${res.status}: ${JSON.stringify(json)}`);
    return json;
  };
  // The page's file; for a Markdown plan, the generated html (the CLI maps .md to .html the same way).
  const fileOf = async (key) => (await (await fetch(`${baseUrl}/api/${key}/status`)).json()).session.file.replace(/\.md$/, ".html");

  const created = await post("/api/workflows", { name: "export-csv", dir, requirements: "Users can export reports as CSV." });
  const wfId = created.workflow.id;
  let key = created.key;
  const order = ["plan", "interrogation", "implementation", "verification"];
  for (const [i, stage] of order.entries()) {
    await post(`/api/${key}/connect-claude`, {});
    const prompt = launches.at(-1).prompt;
    assert(prompt.includes(`· export-csv · ${stage[0].toUpperCase()}${stage.slice(1)}]`), `launch prompt labels ${stage}: ${prompt.slice(0, 60)}`);
    // The fake agent: one note from the human reaches its poll, it replies, then the human approves.
    const file = await fileOf(key);
    await post(`/api/${key}/prompts`, { prompts: [{ prompt_id: `${stage}-1`, prompt: `Note for ${stage}`, tag: "chat", selector: "", text: "" }] }, true);
    const polled = await post("/api/poll", { file, agent: "claude", stage, timeoutMs: 2000 });
    assert(polled.status === "feedback" && polled.stage === stage, `${stage} poll got the note`);
    assert(polled.workflow?.current === stage, `${stage} poll reports the workflow`);
    await post(`/api/${key}/agent-reply`, { text: `Done with ${stage}.` });
    const decided = await post(`/api/${key}/decision`, { decision: "approve" }, true);
    if (i < order.length - 1) {
      assert(decided.next === order[i + 1], `approving ${stage} opens ${order[i + 1]}`);
      key = decided.next_key;
    } else {
      assert(decided.next === null && decided.workflow.current === null, "the workflow finishes");
    }
  }
  const wf = (await (await fetch(`${baseUrl}/api/workflows/${wfId}`)).json()).workflow;
  assert(order.every((s) => wf.stages[s].status === "done" && wf.stages[s].claude_session_id), "every stage done, each with its own Claude session");
  assert(new Set(order.map((s) => wf.stages[s].claude_session_id)).size === 4, "four distinct Claude sessions");
  for (const f of ["export-csv.requirements.md", "export-csv.plan.md", "export-csv.interrogation.html", "export-csv.progress.html", "export-csv.verification.html"]) {
    assert(fs.existsSync(path.join(fs.realpathSync(dir), f)), `${f} exists`);
  }
} catch (e) {
  failure = e;
} finally {
  await srv.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

if (failure) {
  console.error(failure.stack ?? String(failure));
  process.exit(1);
}
console.log("WORKFLOW SMOKE OK");
