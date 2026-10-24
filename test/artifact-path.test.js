import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { canonicalFile, assertHtmlFile, resolveArtifactAsset } from "../src/artifact-path.js";

async function makeTree() {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "mla-path-"));
  const site = path.join(dir, "site");
  await fs.promises.mkdir(path.join(site, "img"), { recursive: true });
  await fs.promises.writeFile(path.join(site, "a.html"), "<html></html>");
  await fs.promises.writeFile(path.join(site, "A.HTM"), "<html></html>");
  await fs.promises.writeFile(path.join(site, "img", "x.png"), "png");
  await fs.promises.writeFile(path.join(dir, "secret.txt"), "secret");
  return { dir, site };
}

test("canonicalFile maps different spellings to one path", async () => {
  const { dir } = await makeTree();
  const plain = await canonicalFile(path.join(dir, "site", "a.html"));
  assert.equal(await canonicalFile(path.join(dir, "site", "..", "site", "a.html")), plain);
  if (process.platform === "win32") {
    assert.equal(await canonicalFile(path.join(dir, "site", "a.html").toUpperCase()), plain);
  }
});

test("assertHtmlFile validates html files", async () => {
  const { dir, site } = await makeTree();
  await assert.rejects(assertHtmlFile(path.join(dir, "secret.txt")), { code: "VALIDATION_ERROR" });
  await assert.rejects(assertHtmlFile(path.join(dir, "missing.html")), {
    code: "VALIDATION_ERROR",
    message: `File not found: ${path.join(dir, "missing.html")}`,
  });
  await assert.rejects(assertHtmlFile(site), { code: "VALIDATION_ERROR" });
  await assertHtmlFile(path.join(site, "A.HTM"));
});

test("resolveArtifactAsset confines to root", async () => {
  const { dir, site } = await makeTree();
  const ok = await resolveArtifactAsset(site, "img/x.png");
  assert.equal(ok, await fs.promises.realpath(path.join(site, "img", "x.png")));
  assert.equal(await resolveArtifactAsset(site, "../secret.txt"), null);
  assert.equal(await resolveArtifactAsset(site, decodeURIComponent("..%2fsecret.txt")), null);
  assert.equal(await resolveArtifactAsset(site, "nope.png"), null);
});

test("resolveArtifactAsset rejects symlink escaping root", async (t) => {
  const { dir, site } = await makeTree();
  try {
    await fs.promises.symlink(path.join(dir, "secret.txt"), path.join(site, "link.txt"));
  } catch (e) {
    if (e.code === "EPERM") return t.skip("symlink not permitted");
    throw e;
  }
  assert.equal(await resolveArtifactAsset(site, "link.txt"), null);
});
