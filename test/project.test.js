import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { datePrefix, findProjectRoot, isPlanFileName, isProjectRoot, listSuperpowersPlans } from "../src/project.js";
import { getProject, listProjects, MAX_PROJECTS, registerProject } from "../src/project-store.js";
import { SessionStore, sessionKey } from "../src/session-store.js";

async function tmpDir(t) {
  const dir = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), "mla-proj-")));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  return dir;
}

const mkdir = (p) => fs.promises.mkdir(p, { recursive: true });

test("D9: the nearest folder with .git, docs/superpowers or .superpowers is the project root", async (t) => {
  const home = await tmpDir(t);
  const repo = path.join(home, "work", "repo");
  await mkdir(path.join(repo, ".git"));
  await mkdir(path.join(repo, "src", "deep"));
  assert.equal(await findProjectRoot(path.join(repo, "src", "deep"), { home }), repo);
  assert.equal(await findProjectRoot(repo, { home }), repo);

  const sp = path.join(home, "notes");
  await mkdir(path.join(sp, "docs", "superpowers", "plans"));
  assert.equal(await findProjectRoot(path.join(sp, "docs"), { home }), sp, "a docs/superpowers folder counts");

  const dot = path.join(home, "dotted");
  await mkdir(path.join(dot, ".superpowers"));
  assert.equal(await findProjectRoot(dot, { home }), dot);

  const gitFile = path.join(home, "worktree");
  await mkdir(gitFile);
  await fs.promises.writeFile(path.join(gitFile, ".git"), "gitdir: elsewhere\n"); // a worktree's .git is a file
  assert.equal(await findProjectRoot(gitFile, { home }), gitFile);

  const plain = path.join(home, "Downloads", "stuff");
  await mkdir(plain);
  assert.equal(await findProjectRoot(plain, { home }), null, "no marker below home");
  assert.equal(await findProjectRoot(home, { home }), null, "home itself");

  await mkdir(path.join(home, ".git")); // a dotfiles repo in ~
  assert.equal(await findProjectRoot(plain, { home }), null, "a .git in home never makes every folder a project");
  assert.equal(await isProjectRoot(home, { home }), false);
  assert.equal(await isProjectRoot(repo, { home }), true);
  assert.equal(await isProjectRoot(plain, { home }), false);
  assert.equal(await findProjectRoot(path.join(home, "missing"), { home }), null);
});

test("D12: plans are the Markdown (and hand-written HTML) files in docs/superpowers/plans, newest created first", async (t) => {
  const root = await tmpDir(t);
  const dir = path.join(root, "docs", "superpowers", "plans");
  await mkdir(path.join(dir, "archive"));
  await fs.promises.writeFile(path.join(dir, "2026-10-24-a.md"), "intro\n# Plan A title\nbody");
  await fs.promises.writeFile(path.join(dir, "2026-10-24-a.html"), "<html>generated</html>"); // made from the .md
  await fs.promises.writeFile(path.join(dir, "2026-11-01-b.html"), "<html>hand-written</html>");
  await fs.promises.writeFile(path.join(dir, "2026-11-03-c.markdown"), "no heading");
  await fs.promises.writeFile(path.join(dir, "undated.md"), "# Undated\n");
  await fs.promises.writeFile(path.join(dir, "notes.txt"), "not a plan");
  await fs.promises.writeFile(path.join(dir, "archive", "2027-01-01-old.md"), "# in a subfolder\n");
  let linked = false;
  try {
    await fs.promises.symlink(path.join(root, "outside.md"), path.join(dir, "2030-01-01-link.md"));
    linked = true;
  } catch {} // symlinks need extra rights on Windows

  const { items, total } = await listSuperpowersPlans(root);
  const names = items.map((p) => p.name);
  assert.ok(!names.includes("2026-10-24-a.html"), "HTML generated from a sibling .md is left out");
  assert.ok(!names.includes("notes.txt") && !names.includes("2027-01-01-old.md"), "other files and subfolders are left out");
  if (linked) assert.ok(!names.includes("2030-01-01-link.md"), "symlinks are skipped");
  // An undated file is "created" at its birth time (today here), so it sorts above the dated ones.
  assert.deepEqual(names, ["undated.md", "2026-11-03-c.markdown", "2026-11-01-b.html", "2026-10-24-a.md"]);
  assert.equal(total, 4);
  const a = items.find((p) => p.name === "2026-10-24-a.md");
  assert.equal(a.title, "Plan A title");
  assert.equal(a.file, path.join(await fs.promises.realpath(dir), "2026-10-24-a.md"));
  assert.equal(items.find((p) => p.name === "2026-11-03-c.markdown").title, "");
  assert.equal(items.find((p) => p.name === "2026-11-01-b.html").title, "", "HTML plans use their file name");
  assert.deepEqual(await listSuperpowersPlans(path.join(root, "nope")), { items: [], total: 0 });
});

test("D12: the listing is capped at 50, and a 200-file listing is fast when warm", async (t) => {
  const root = await tmpDir(t);
  const dir = path.join(root, "docs", "superpowers", "plans");
  await mkdir(dir);
  for (let i = 0; i < 200; i++) {
    const day = String((i % 28) + 1).padStart(2, "0");
    const month = String((Math.floor(i / 28) % 12) + 1).padStart(2, "0");
    await fs.promises.writeFile(path.join(dir, `2025-${month}-${day}-p${i}.md`), `# Plan ${i}\n`);
  }
  const first = await listSuperpowersPlans(root, { limit: 500 });
  assert.equal(first.items.length, 50);
  assert.equal(first.total, 50);
  assert.ok(first.items[0].created_at >= first.items[49].created_at);
  const t0 = performance.now();
  await listSuperpowersPlans(root);
  const warm = performance.now() - t0;
  assert.ok(warm < 100, `warm listing ${warm}ms`);
});

test("datePrefix and isPlanFileName", () => {
  assert.equal(datePrefix("2026-11-04-x.md"), new Date(2026, 10, 4).toISOString());
  assert.equal(datePrefix("2026-02-30-x.md"), null, "not a real date");
  assert.equal(datePrefix("x-2026-11-04.md"), null);
  assert.equal(datePrefix("20261104.md"), null);
  for (const ok of ["a.md", "2026-11-04-x.markdown", "b.html", "c.HTM"]) assert.equal(isPlanFileName(ok), true, ok);
  for (const bad of ["../a.md", "a/b.md", "a\\b.md", "a.txt", "", "..md", "a\0.md", 5, null]) assert.equal(isPlanFileName(bad), false, String(bad));
});

test("project store: stable keys, last_seen order, a cap of 50, prototype keys refused", async (t) => {
  const stateDir = await tmpDir(t);
  const store = new SessionStore(stateDir);
  const a = await registerProject(store, path.join(stateDir, "a"));
  assert.deepEqual([a.key, a.name], [sessionKey(path.join(stateDir, "a")), "a"]);
  await registerProject(store, path.join(stateDir, "b"));
  const again = await registerProject(store, path.join(stateDir, "a"));
  assert.equal(again.key, a.key);
  assert.equal(again.registered_at, a.registered_at, "registration time is kept");
  assert.deepEqual((await listProjects(store)).map((p) => p.name), ["a", "b"], "most recently seen first");
  assert.deepEqual(await getProject(store, a.key), again);
  assert.equal(await getProject(store, "__proto__"), null);
  assert.equal(await getProject(store, "0123456789abcdef"), null);
  for (let i = 0; i < MAX_PROJECTS + 5; i++) await registerProject(store, path.join(stateDir, `p${i}`));
  const all = await listProjects(store, { limit: 500 });
  assert.equal(all.length, MAX_PROJECTS);
  assert.ok(!all.some((p) => p.name === "b"), "the least recently seen is dropped");
  assert.equal(all[0].name, `p${MAX_PROJECTS + 4}`);
});
